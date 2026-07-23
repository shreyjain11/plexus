import { useCallback, useEffect, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
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
// Hysteresis: engage tight, release loose, so a held pinch never flickers.
const PINCH_DOWN = 0.45;
const PINCH_UP = 0.62;

// One-Euro tuning: precise when still, low-lag when the hand moves fast.
const FILTER = { minCutoff: 1.2, beta: 0.012, dCutoff: 1.0 } as const;

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
  enable: () => void;
  disable: () => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  overlayRef: React.RefObject<HTMLCanvasElement | null>;
}

interface Options {
  input: StrokeInput;
  mode: Mode;
  /** The drawing surface, for mapping normalized landmarks to scene pixels. */
  stageRef: React.RefObject<HTMLElement | null>;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Webcam hand tracking that feeds the shared stroke lifecycle: the index
 * fingertip is the cursor, a thumb↔index pinch is pen-down. Landmarks are
 * One-Euro smoothed before use. Everything degrades gracefully — denied
 * permission, missing camera, or a model-load failure simply leaves mouse and
 * touch fully in control.
 */
export function useHandTracking({ input, mode, stageRef }: Options): HandTracking {
  const [status, setStatus] = useState<HandStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [penDown, setPenDown] = useState(false);
  const [handPresent, setHandPresent] = useState(false);
  const [cursor, setCursor] = useState<Point | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  // Latest values, read inside the rAF loop without re-subscribing.
  const inputRef = useRef(input);
  inputRef.current = input;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const filterRef = useRef(new OneEuroPoint(FILTER));
  const lastVideoTimeRef = useRef(-1);
  const pinchedRef = useRef(false);
  const drawingRef = useRef(false);
  const runningRef = useRef(false);

  const drawOverlay = useCallback((lm: HandLandmarkerResult["landmarks"][number] | null) => {
    const cv = overlayRef.current;
    if (!cv) return;
    const w = cv.clientWidth || 160;
    const h = cv.clientHeight || 120;
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (!lm) return;

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
  }, []);

  const endStrokeIfDrawing = useCallback(() => {
    if (drawingRef.current) {
      drawingRef.current = false;
      inputRef.current.end();
    }
  }, []);

  const onFrame = useCallback(
    (result: HandLandmarkerResult, now: number) => {
      const lm = result.landmarks?.[0] ?? null;
      drawOverlay(lm);

      if (!lm) {
        endStrokeIfDrawing();
        if (pinchedRef.current) {
          pinchedRef.current = false;
          setPenDown(false);
        }
        setHandPresent(false);
        setCursor(null);
        filterRef.current.reset();
        return;
      }
      setHandPresent(true);

      const wrist = lm[WRIST]!;
      const indexMcp = lm[INDEX_MCP]!;
      const thumbTip = lm[THUMB_TIP]!;
      const indexTip = lm[INDEX_TIP]!;

      const scale = Math.max(dist(wrist, indexMcp), 1e-4);
      const ratio = dist(thumbTip, indexTip) / scale;

      const smoothed = filterRef.current.filter(indexTip.x, indexTip.y, now);
      const rect = stageRef.current?.getBoundingClientRect();
      const width = rect?.width ?? 1000;
      const height = rect?.height ?? 700;
      // Mirror x so moving the hand right moves the cursor right.
      const scenePt: Point = { x: (1 - smoothed.x) * width, y: smoothed.y * height };
      setCursor(scenePt);

      if (!pinchedRef.current && ratio < PINCH_DOWN) {
        pinchedRef.current = true;
        setPenDown(true);
        if (modeRef.current === "draw") {
          drawingRef.current = true;
          inputRef.current.begin(scenePt);
        }
      } else if (pinchedRef.current && ratio > PINCH_UP) {
        pinchedRef.current = false;
        setPenDown(false);
        endStrokeIfDrawing();
      } else if (drawingRef.current) {
        inputRef.current.extend(scenePt);
      }
    },
    [drawOverlay, endStrokeIfDrawing, stageRef],
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
    runningRef.current = false;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    endStrokeIfDrawing();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const v = videoRef.current;
    if (v) v.srcObject = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    filterRef.current.reset();
    pinchedRef.current = false;
    lastVideoTimeRef.current = -1;
    setPenDown(false);
    setHandPresent(false);
    setCursor(null);
    setStatus("idle");
  }, [endStrokeIfDrawing]);

  const enable = useCallback(async () => {
    if (runningRef.current || status === "loading") return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setStatus("unsupported");
      setErrorMessage("This browser has no camera API.");
      return;
    }
    setStatus("loading");
    setErrorMessage(null);

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

    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      try {
        landmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 1,
        });
      } catch {
        // Some browsers/GPUs reject the WebGL delegate — fall back to CPU.
        landmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          runningMode: "VIDEO",
          numHands: 1,
        });
      }
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      video.srcObject = null;
      setStatus("error");
      setErrorMessage("Could not load the hand-tracking model (offline?).");
      return;
    }

    runningRef.current = true;
    filterRef.current.reset();
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
    enable: () => void enable(),
    disable,
    videoRef,
    overlayRef,
  };
}
