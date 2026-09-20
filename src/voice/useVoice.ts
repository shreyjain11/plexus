import { useCallback, useEffect, useRef, useState } from "react";
import { parseUtterance } from "./grammar";
import { parseRemote, remoteDisabled } from "./remote";
import type { VoiceOp } from "./ops";
import type { LocalState } from "./local";

/**
 * Speech capture and the command pipeline.
 *
 * Recognition is the browser's own Web Speech API — no audio ever leaves the
 * page for a service we run, and the feature needs no key to work. The hook
 * owns the messy parts of that API: sessions that end on their own every
 * ~60 seconds, `no-speech` errors that are not really errors, and interim
 * results that must not be executed.
 *
 * `run()` is the same entry point the typed-command box uses, so every path
 * through the parser and planner is reachable without a microphone — which is
 * also how the e2e tests drive it.
 */

// The Web Speech API is still vendor-prefixed in Safari and absent from the
// DOM lib in some TS versions, so the surface used here is declared locally.
interface SpeechAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechResult {
  readonly length: number;
  readonly isFinal: boolean;
  readonly [index: number]: SpeechAlternative | undefined;
}
interface SpeechResultList {
  readonly length: number;
  readonly [index: number]: SpeechResult | undefined;
}
interface SpeechEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechResultList;
}
interface SpeechErrorEvent extends Event {
  readonly error: string;
}
interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type RecognizerCtor = new () => Recognizer;

function recognizerCtor(): RecognizerCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognizerCtor;
    webkitSpeechRecognition?: RecognizerCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type VoiceStatus = "unsupported" | "idle" | "listening" | "denied" | "error";

export interface VoiceEntry {
  id: number;
  /** What was heard or typed. */
  text: string;
  ok: boolean;
  /** Short summary of the outcome, shown under the transcript. */
  detail: string;
}

/** What the shell does with a parsed command; returns a line for the log. */
export type VoiceApply = (ops: readonly VoiceOp[], text: string) => { ok: boolean; detail: string };

export interface UseVoiceOptions {
  apply: VoiceApply;
  /** Current node labels, used only as context for the optional LLM tier. */
  labels: () => string[];
}

export interface VoiceApi {
  supported: boolean;
  status: VoiceStatus;
  listening: boolean;
  /** The partial phrase currently being spoken, or "". */
  interim: string;
  /** Recent commands, newest first. */
  log: VoiceEntry[];
  /** Commands run this session, ever — `log` is capped, this is not. */
  ran: number;
  /** True while a second-tier parser is being consulted. */
  thinking: boolean;
  /** The in-browser model tier: off, downloading, ready, or broken. */
  local: LocalState;
  /** Turn the in-browser model on or off. Downloads on first enable. */
  setLocal: (on: boolean) => void;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  /** Run one command as if it had been spoken. */
  run: (text: string) => Promise<void>;
}

const LOG_CAP = 6;
/** Remembers the opt-in, so the model is not re-downloaded-and-forgotten. */
const LOCAL_KEY = "plexus.voice.local";

function storedOptIn(): boolean {
  try {
    return localStorage.getItem(LOCAL_KEY) === "on";
  } catch {
    return false; // private mode, or storage disabled
  }
}
/** Chrome ends a continuous session roughly every minute; restart quietly. */
const RESTART_MS = 250;
const MAX_BACKOFF_MS = 4000;

export function useVoice({ apply, labels }: UseVoiceOptions): VoiceApi {
  const [supported] = useState(() => recognizerCtor() !== null);
  const [status, setStatus] = useState<VoiceStatus>(() =>
    recognizerCtor() === null ? "unsupported" : "idle",
  );
  const [interim, setInterim] = useState("");
  const [log, setLog] = useState<VoiceEntry[]>([]);
  const [ran, setRan] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [local, setLocalState] = useState<LocalState>({ status: "off", progress: null });

  const recRef = useRef<Recognizer | null>(null);
  const wantRef = useRef(false);
  const backoffRef = useRef(RESTART_MS);
  const restartRef = useRef<number | null>(null);
  const entryId = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  // Callbacks change every render; read them through refs so the recognizer is
  // built once and never torn down mid-sentence.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  const pushEntry = useCallback((text: string, ok: boolean, detail: string) => {
    entryId.current += 1;
    const entry: VoiceEntry = { id: entryId.current, text, ok, detail };
    setLog((prev) => [entry, ...prev].slice(0, LOG_CAP));
    setRan((n) => n + 1);
  }, []);

  // The whole local tier — model, worker, prototypes — is loaded on demand, so
  // that a session that never opts in never downloads a byte of it. A static
  // import would put it in the entry chunk's graph for everyone.
  const localRef = useRef<typeof import("./local") | null>(null);
  const loadLocal = useCallback(async () => {
    localRef.current ??= await import("./local");
    return localRef.current;
  }, []);

  const setLocal = useCallback(
    (on: boolean) => {
      try {
        localStorage.setItem(LOCAL_KEY, on ? "on" : "off");
      } catch {
        /* storage disabled; the choice just won't survive a reload */
      }
      void loadLocal().then((mod) => {
        if (on) void mod.enableLocal();
        else mod.disableLocal();
      });
    },
    [loadLocal],
  );

  // Subscribe once, and resume a previous opt-in. The unsubscribe is returned
  // from inside the promise, so keep a flag for the case where the component
  // unmounts before the dynamic import lands.
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    void loadLocal().then((mod) => {
      if (!alive) return;
      off = mod.onLocalState(setLocalState);
      if (storedOptIn()) void mod.enableLocal();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [loadLocal]);

  /** Parse one utterance, escalating leftovers to whichever tiers are available. */
  const execute = useCallback(
    async (text: string): Promise<void> => {
      const said = text.trim();
      if (said === "") return;

      const { ops, unparsed } = parseUtterance(said);
      let all: VoiceOp[] = ops;

      // Tier 1 handles the literal phrasings. Anything left is oblique enough
      // to need a model, and there may be two to try: the hosted one if this
      // deploy has a key, and the in-browser one if the user turned it on.
      // Hosted goes first where both exist — it is the better parser — and the
      // local tier picks up both the no-key deploy and the hosted tier's
      // refusals, which cost nothing to retry.
      if (unparsed.length > 0) {
        const leftover = unparsed.join(". ");
        setThinking(true);
        try {
          if (!remoteDisabled()) {
            const remote = await parseRemote(leftover, { labels: labelsRef.current() });
            if (remote.ops.length > 0) all = [...all, ...remote.ops];
          }
          if (all.length === ops.length && localRef.current !== null) {
            const found = await localRef.current.parseLocal(leftover, {
              labels: labelsRef.current(),
            });
            if (found.ops.length > 0) all = [...all, ...found.ops];
          }
        } finally {
          setThinking(false);
        }
      }

      if (all.length === 0) {
        pushEntry(said, false, "not understood");
        return;
      }
      const result = applyRef.current(all, said);
      pushEntry(said, result.ok, result.detail);
    },
    [pushEntry],
  );

  /** Serialise commands so two quick phrases cannot interleave their plans. */
  const run = useCallback(
    (text: string): Promise<void> => {
      const next = queueRef.current.then(() => execute(text));
      // Keep the chain alive even if one command throws.
      queueRef.current = next.catch(() => undefined);
      return next;
    },
    [execute],
  );
  const runRef = useRef(run);
  runRef.current = run;

  const clearRestart = useCallback(() => {
    if (restartRef.current !== null) {
      clearTimeout(restartRef.current);
      restartRef.current = null;
    }
  }, []);

  // Declared up front with an explicit type: `openSession` schedules its own
  // re-entry from `onend`, and a self-referencing const needs the annotation.
  const openSessionRef = useRef<() => void>(() => {});

  const openSession = useCallback(() => {
    const Ctor = recognizerCtor();
    if (!Ctor) return;

    const rec = new Ctor();
    rec.lang = typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      backoffRef.current = RESTART_MS;
      setStatus("listening");
    };

    rec.onresult = (e) => {
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const alt = result?.[0];
        if (!result || !alt) continue;
        if (result.isFinal) void runRef.current(alt.transcript);
        else pending += alt.transcript;
      }
      setInterim(pending.trim());
    };

    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        wantRef.current = false;
        setStatus("denied");
        setInterim("");
        try {
          rec.abort();
        } catch {
          /* already dead */
        }
        return;
      }
      // "no-speech", "aborted" and "network" are routine; back off and retry.
      backoffRef.current = Math.min(MAX_BACKOFF_MS, backoffRef.current * 2);
    };

    rec.onend = () => {
      setInterim("");
      recRef.current = null;
      if (!wantRef.current) {
        setStatus("idle");
        return;
      }
      // A session ended on its own — reopen it so listening feels continuous.
      clearRestart();
      restartRef.current = window.setTimeout(() => {
        restartRef.current = null;
        if (wantRef.current) openSessionRef.current();
      }, backoffRef.current);
    };

    recRef.current = rec;
    try {
      rec.start();
      setStatus("listening");
    } catch {
      // start() throws if a session is somehow still open; treat as recoverable.
      wantRef.current = false;
      recRef.current = null;
      setStatus("error");
    }
  }, [clearRestart]);
  openSessionRef.current = openSession;

  const start = useCallback(() => {
    if (wantRef.current) return;
    if (recognizerCtor() === null) {
      setStatus("unsupported");
      return;
    }
    wantRef.current = true;
    backoffRef.current = RESTART_MS;
    openSessionRef.current();
  }, []);

  const stop = useCallback(() => {
    wantRef.current = false;
    clearRestart();
    setInterim("");
    const rec = recRef.current;
    recRef.current = null;
    setStatus((s) => (s === "denied" ? s : "idle"));
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      /* nothing to stop */
    }
  }, [clearRestart]);

  const toggle = useCallback(() => {
    if (wantRef.current) stop();
    else start();
  }, [start, stop]);

  // Release the microphone on unmount — a live recognizer keeps the tab's
  // recording indicator on and can block the next page that wants it.
  useEffect(
    () => () => {
      wantRef.current = false;
      if (restartRef.current !== null) clearTimeout(restartRef.current);
      try {
        recRef.current?.abort();
      } catch {
        /* already gone */
      }
      recRef.current = null;
    },
    [],
  );

  return {
    supported,
    status,
    listening: status === "listening",
    interim,
    log,
    ran,
    thinking,
    local,
    setLocal,
    start,
    stop,
    toggle,
    run,
  };
}
