import { useCallback, useEffect, useRef, useState } from "react";
import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import type { Mode } from "../components/Canvas";
import type { StrokeInput } from "./useStrokeInput";
import { OneEuroPoint } from "./oneEuro";
import type { Point } from "../types";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Landmark indices in MediaPipe's 21-point hand model.
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_TIP = 8;

// Pinch thresholds as a fraction of hand scale (wrist → index knuckle).
// Hysteresis (engage tight, release loose) + N-frame debounce: a held pinch
// never flickers and a single noisy frame never starts or ends a stroke.
const PINCH_DOWN = 0.42;
const PINCH_UP = 0.6;
const DEBOUNCE_FRAMES = 2;

/** Frames dropped right after pen-down — the "grab jerk". */
const START_SKIP_FRAMES = 2;
/** Trailing window trimmed at pen-up — the "release hook" (ms). */
const END_TRIM_MS = 90;

/** Hands with a weaker handedness score than this are treated as absent. */
const MIN_HAND_SCORE = 0.8;

// One-Euro tuning: steadier while inking, snappier while hovering.
const FILTER_BASE = { minCutoff: 1.6, beta: 0.012, dCutoff: 1.0 } as const;
const MIN_CUTOFF_PEN = 0.9;
const MIN_CUTOFF_HOVER = 1.6;

const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

export type HandStatus = "idle" | "loading" | "running" | "denied" | "unsupported" | "error";

export interface HandTracking {
  status: HandStatus;
  errorMessage: string | null;
  penDown: boolean;
  handPresent: boolean;
  cursor: Point | null;
  cursor2: Point | null;
  enable: () => void;
  disable: () => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  overlayRef: React.RefObject<HTMLCanvasElement | null>;
}

/** Callbacks the app supplies; all must be referentially stable. */
export interface HandApi {
  /** Mirrored camera-normalized coords → scene coords (margin + view). */
  mapToScene: (nx: number, ny: number) => Point;
  /** Select-mode pinch: try to grab a node. Returns true when one was hit. */
  pinchSelectStart: (p: Point) => boolean;
  pinchSelectMove: (p: Point) => void;
  pinchSelectEnd: () => void;
  /** Two-hand framing gesture lifecycle (scene-space corners). */
  frameUpdate: (a: Point, b: Point) => void;
  frameCommit: (a: Point, b: Point) => void;
  frameCancel: () => void;
}

interface Options {
  input: StrokeInput;
  mode: Mode;
  api: HandApi;
}

function dist2d(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Per-hand pinch/cursor state. Two of these run when both hands are up. */
class HandState {
  readonly filter = new OneEuroPoint(FILTER_BASE);
  pinched = false;
  belowFrames = 0;
  aboveFrames = 0;
  /** 0 = index-tip anchor (hover), 1 = pinch-midpoint anchor (inking). */
  nibWeight = 0;
  cursor: Point | null = null;
  present = false;
  justPinched = false;
  justReleased = false;

  update(lm: NormalizedLandmark[], now: number, mapToScene: (nx: number, ny: number) => Point): void {
    this.present = true;
    this.justPinched = false;
    this.justReleased = false;

    const wrist = lm[WRIST]!;
    const indexMcp = lm[INDEX_MCP]!;
    const thumbTip = lm[THUMB_TIP]!;
    const indexTip = lm[INDEX_TIP]!;
    const scale = Math.max(dist2d(wrist, indexMcp), 1e-4);
    const ratio = dist2d(thumbTip, indexTip) / scale;

    // Debounced hysteresis FSM.
    if (!this.pinched) {
      this.belowFrames = ratio < PINCH_DOWN ? this.belowFrames + 1 : 0;
      if (this.belowFrames >= DEBOUNCE_FRAMES) {
        this.pinched = true;
        this.justPinched = true;
        this.belowFrames = 0;
        this.filter.updateConfig({ minCutoff: MIN_CUTOFF_PEN });
      }
    } else {
      this.aboveFrames = ratio > PINCH_UP ? this.aboveFrames + 1 : 0;
      if (this.aboveFrames >= DEBOUNCE_FRAMES) {
        this.pinched = false;
        this.justReleased = true;
        this.aboveFrames = 0;
        this.filter.updateConfig({ minCutoff: MIN_CUTOFF_HOVER });
      }
    }

    // Anchor: index tip while hovering, thumb↔index midpoint while pinched
    // (the "nib" — far steadier than the curling index tip). Crossfade over a
    // few frames so pen-down doesn't jump.
    const target = this.pinched ? 1 : 0;
    this.nibWeight += Math.sign(target - this.nibWeight) * Math.min(0.34, Math.abs(target - this.nibWeight));
    const mx = (thumbTip.x + indexTip.x) / 2;
    const my = (thumbTip.y + indexTip.y) / 2;
    const ax = indexTip.x + (mx - indexTip.x) * this.nibWeight;
    const ay = indexTip.y + (my - indexTip.y) * this.nibWeight;

    // Mirror x so moving the hand right moves the cursor right, then smooth
    // in normalized space and map through the margin window + viewport.
    const smoothed = this.filter.filter(1 - ax, ay, now);
    this.cursor = mapToScene(smoothed.x, smoothed.y);
  }

  reset(): void {
    if (this.pinched) this.justReleased = true;
    this.pinched = false;
    this.present = false;
    this.belowFrames = 0;
    this.aboveFrames = 0;
    this.nibWeight = 0;
    this.cursor = null;
    this.filter.reset();
    this.filter.updateConfig({ minCutoff: MIN_CUTOFF_HOVER });
  }
}

/**
 * Webcam hand tracking feeding the shared stroke lifecycle. One pinched hand
 * draws (draw mode) or grabs nodes (select mode); two pinched hands frame a
 * shape between them. Everything degrades gracefully — denied permission,
 * missing camera, or a model-load failure leaves mouse and touch in control.
 */
export function useHandTracking({ input, mode, api }: Options): HandTracking {
  const [status, setStatus] = useState<HandStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [penDown, setPenDown] = useState(false);
  const [handPresent, setHandPresent] = useState(false);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [cursor2, setCursor2] = useState<Point | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  // Latest values, read inside the rAF loop without re-subscribing.
  const inputRef = useRef(input);
  inputRef.current = input;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const apiRef = useRef(api);
  apiRef.current = api;

  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const sessionRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const runningRef = useRef(false);

  // Interaction state across frames.
  const handsRef = useRef<[HandState, HandState]>([new HandState(), new HandState()]);
  const drawingRef = useRef<{ hand: number; started: boolean; skip: number; times: number[] } | null>(null);
  const grabbingRef = useRef<number | null>(null);
  const framingRef = useRef<{ frames: number } | null>(null);

  const drawOverlay = useCallback((allHands: NormalizedLandmark[][]) => {
    const cv = overlayRef.current;
    if (!cv) return;
    const w = cv.clientWidth || 160;
    const h = cv.clientHeight || 120;
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    for (const lm of allHands) {
      ctx.strokeStyle = "rgba(53, 99, 233, 0.85)";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = lm[a];
        const pb = lm[b];
        if (!pa || !pb) continue;
        ctx.beginPath();
        ctx.moveTo(pa.x * w, pa.y * h);
        ctx.lineTo(pb.x * w, pb.y * h);
        ctx.stroke();
      }
      for (let i = 0; i < lm.length; i++) {
        const p = lm[i]!;
        const tip = i === THUMB_TIP || i === INDEX_TIP;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, tip ? 4 : 2.2, 0, Math.PI * 2);
        ctx.fillStyle = tip ? "#3563e9" : "#e8eaee";
        ctx.fill();
      }
    }
  }, []);

  const endStrokeIfDrawing = useCallback((commit: boolean) => {
    const d = drawingRef.current;
    drawingRef.current = null;
    if (!d || !d.started) return;
    if (!commit) {
      inputRef.current.cancel();
      return;
    }
    // Trim the release hook: points appended in the final END_TRIM_MS distort
    // the endpoints the connector classifier depends on.
    const now = performance.now();
    let trim = 0;
    for (let i = d.times.length - 1; i >= 0 && now - d.times[i]! < END_TRIM_MS; i--) trim++;
    if (trim > 0) inputRef.current.trimTail(trim);
    inputRef.current.end();
  }, []);

  const stopGrab = useCallback(() => {
    if (grabbingRef.current !== null) {
      grabbingRef.current = null;
      apiRef.current.pinchSelectEnd();
    }
  }, []);

  const onFrame = useCallback(
    (result: HandLandmarkerResult, now: number) => {
      const states = handsRef.current;
      const detected: { lm: NormalizedLandmark[]; slot: number }[] = [];

      // Assign detected hands to stable slots by handedness label so a hand's
      // filter and pinch state survive frame-order shuffles.
      const seen = [false, false];
      for (let i = 0; i < (result.landmarks?.length ?? 0); i++) {
        const lm = result.landmarks[i];
        const hd = result.handedness?.[i]?.[0];
        if (!lm || !hd || hd.score < MIN_HAND_SCORE) continue;
        const slot = hd.categoryName === "Left" ? 0 : 1;
        if (seen[slot]) continue;
        seen[slot] = true;
        detected.push({ lm, slot });
      }
      drawOverlay(detected.map((d) => d.lm));

      for (const { lm, slot } of detected) {
        states[slot]!.update(lm, now, apiRef.current.mapToScene);
      }
      for (let s = 0; s < 2; s++) {
        if (!seen[s] && states[s]!.present) states[s]!.reset();
      }

      const [a, b] = states;
      const pinchedHands = [a.pinched ? 0 : -1, b.pinched ? 1 : -1].filter((i) => i >= 0);

      // ---- two-hand framing has priority over everything ----
      if (pinchedHands.length === 2 && a.cursor && b.cursor) {
        if (!framingRef.current) {
          endStrokeIfDrawing(false); // a stroke in progress becomes the frame
          stopGrab();
          framingRef.current = { frames: 0 };
        }
        framingRef.current.frames++;
        apiRef.current.frameUpdate(a.cursor, b.cursor);
      } else if (framingRef.current) {
        const f = framingRef.current;
        framingRef.current = null;
        if (f.frames >= 3 && a.cursor && b.cursor) {
          apiRef.current.frameCommit(a.cursor, b.cursor);
        } else {
          apiRef.current.frameCancel();
        }
      }

      // ---- single-hand interaction (skip entirely while framing) ----
      if (!framingRef.current) {
        const d = drawingRef.current;
        const activeIdx = d ? d.hand : pinchedHands.length > 0 ? pinchedHands[0]! : -1;
        const active = activeIdx >= 0 ? states[activeIdx]! : null;

        if (active && active.pinched && active.cursor) {
          if (modeRef.current === "draw" || modeRef.current === "write") {
            if (!d) {
              drawingRef.current = { hand: activeIdx, started: false, skip: START_SKIP_FRAMES, times: [] };
            } else if (d.skip > 0) {
              d.skip--; // drop the grab jerk
            } else if (!d.started) {
              d.started = true;
              d.times.push(now);
              inputRef.current.begin(active.cursor);
            } else {
              d.times.push(now);
              inputRef.current.extend(active.cursor);
            }
          } else if (modeRef.current === "select") {
            if (active.justPinched && grabbingRef.current === null) {
              if (apiRef.current.pinchSelectStart(active.cursor)) {
                grabbingRef.current = activeIdx;
              }
            } else if (grabbingRef.current === activeIdx) {
              apiRef.current.pinchSelectMove(active.cursor);
            }
          }
        } else {
          if (d && (!active || !active.pinched)) {
            endStrokeIfDrawing(states[d.hand]!.present); // hand lost mid-stroke → discard
          }
          if (grabbingRef.current !== null && (!active || !active.pinched)) {
            stopGrab();
          }
        }
      }

      // ---- published UI state ----
      const primary = a.present ? a : b;
      const secondary = a.present && b.present ? b : null;
      setHandPresent(a.present || b.present);
      setPenDown(primary.pinched && primary.present);
      setCursor(primary.present ? primary.cursor : null);
      setCursor2(secondary ? secondary.cursor : null);
    },
    [drawOverlay, endStrokeIfDrawing, stopGrab],
  );

  const loop = useCallback(() => {
    if (!runningRef.current) return;
    const video = videoRef.current;
    const landmarker = landmarkerRef.current;
    if (video && landmarker && video.readyState >= 2) {
      const now = performance.now();
      if (video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime;
        try {
          onFrame(landmarker.detectForVideo(video, now), now);
        } catch {
          /* transient detection error — keep looping */
        }
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  }, [onFrame]);

  const disable = useCallback(() => {
    sessionRef.current += 1;
    runningRef.current = false;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    endStrokeIfDrawing(false);
    stopGrab();
    if (framingRef.current) {
      framingRef.current = null;
      apiRef.current.frameCancel();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const v = videoRef.current;
    if (v) v.srcObject = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    handsRef.current.forEach((h) => h.reset());
    lastVideoTimeRef.current = -1;
    setPenDown(false);
    setHandPresent(false);
    setCursor(null);
    setCursor2(null);
    setStatus("idle");
  }, [endStrokeIfDrawing, stopGrab]);

  const enable = useCallback(async () => {
    if (runningRef.current || status === "loading") return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setStatus("unsupported");
      setErrorMessage("This browser has no camera API.");
      return;
    }
    setStatus("loading");
    setErrorMessage(null);
    const session = ++sessionRef.current;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setStatus("denied");
        setErrorMessage("Camera permission denied.");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setStatus("error");
        setErrorMessage("No camera found.");
      } else {
        setStatus("error");
        setErrorMessage("Could not start the camera.");
      }
      return;
    }

    if (sessionRef.current !== session) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) {
      stream.getTracks().forEach((t) => t.stop());
      setStatus("error");
      return;
    }
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      /* autoplay policies vary; muted+playsInline video usually still plays */
    }

    let landmarker: HandLandmarker;
    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      try {
        landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 2,
          minTrackingConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
        });
      } catch {
        // Some browsers/GPUs reject the WebGL delegate — fall back to CPU.
        landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          runningMode: "VIDEO",
          numHands: 2,
          minTrackingConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
        });
      }
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      if (streamRef.current === stream) streamRef.current = null;
      video.srcObject = null;
      if (sessionRef.current === session) {
        setStatus("error");
        setErrorMessage("Could not load the hand-tracking model (offline?).");
      }
      return;
    }

    if (sessionRef.current !== session) {
      landmarker.close();
      stream.getTracks().forEach((t) => t.stop());
      if (streamRef.current === stream) streamRef.current = null;
      video.srcObject = null;
      return;
    }

    landmarkerRef.current = landmarker;
    runningRef.current = true;
    handsRef.current.forEach((h) => h.reset());
    setStatus("running");
    rafRef.current = requestAnimationFrame(loop);
  }, [status, loop]);

  // Tear everything down on unmount.
  useEffect(() => () => disable(), [disable]);

  return {
    status,
    errorMessage,
    penDown,
    handPresent,
    cursor,
    cursor2,
    enable: () => void enable(),
    disable,
    videoRef,
    overlayRef,
  };
}
