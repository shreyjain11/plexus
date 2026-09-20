import { buildRequest, decode } from "../jev";
import { validateOps, type VoiceOp } from "../ops";
import { answerLocally, embedPrototypes, type Embedder, type Prototypes } from "./answer";

/**
 * The free tier, assembled: worker, prototypes, and the shared decoder.
 *
 * This mirrors `parseRemote` on purpose — same call shape, same "never throws,
 * zero ops on failure" contract — so `useVoice` treats the two the same way and
 * can fall from one to the other without knowing anything about either.
 *
 * Everything is lazy. No worker is spawned, no model is fetched, and no bytes
 * cross the network until someone calls `enableLocal()`. A user who never turns
 * this on pays nothing for its existence.
 */

export type LocalStatus = "off" | "loading" | "ready" | "failed";

/** Progress of the one-time model download, 0–1, or null before it starts. */
export interface LocalState {
  status: LocalStatus;
  progress: number | null;
}

type Listener = (s: LocalState) => void;

let state: LocalState = { status: "off", progress: null };
const listeners = new Set<Listener>();

function setState(next: Partial<LocalState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l(state);
}

export function localState(): LocalState {
  return state;
}

export function onLocalState(l: Listener): () => void {
  listeners.add(l);
  l(state);
  return () => listeners.delete(l);
}

// ---------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (v: Float32Array[]) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let protos: Prototypes | null = null;
let warming: Promise<void> | null = null;

function spawn(): Worker {
  if (worker !== null) return worker;
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent) => {
    const m = e.data as {
      kind: string;
      id?: number;
      dims?: number;
      data?: Float32Array;
      loaded?: number;
      total?: number;
      message?: string;
    };
    if (m.kind === "progress" && typeof m.loaded === "number" && m.total) {
      setState({ progress: Math.min(1, m.loaded / m.total) });
      return;
    }
    if (m.kind === "embedded" && typeof m.id === "number" && m.data && typeof m.dims === "number") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      p?.resolve(unflatten(m.data, m.dims));
      return;
    }
    if (m.kind === "failed") {
      const err = new Error(m.message ?? "embedding failed");
      if (typeof m.id === "number") {
        pending.get(m.id)?.reject(err);
        pending.delete(m.id);
      }
      setState({ status: "failed" });
    }
  };
  w.onerror = () => {
    for (const p of pending.values()) p.reject(new Error("worker crashed"));
    pending.clear();
    setState({ status: "failed" });
  };
  worker = w;
  return w;
}

/** Split one flat [n × dims] buffer back into n vectors. */
function unflatten(data: Float32Array, dims: number): Float32Array[] {
  if (dims <= 0) return [];
  const out: Float32Array[] = [];
  for (let i = 0; i + dims <= data.length; i += dims) out.push(data.subarray(i, i + dims));
  return out;
}

const embed: Embedder = (texts) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    spawn().postMessage({ kind: "embed", id, texts: [...texts] });
  });

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Start the download and embed the prototypes. Safe to call repeatedly; the
 * second call joins the first rather than starting over.
 */
export function enableLocal(): Promise<void> {
  warming ??= (async () => {
    setState({ status: "loading", progress: null });
    try {
      // The prototypes are the same every time, so this doubles as the warm-up:
      // by the time it resolves the model is resident and the first real
      // utterance costs one short forward pass, not a cold start.
      protos = await embedPrototypes(embed);
      setState({ status: "ready", progress: 1 });
    } catch {
      protos = null;
      warming = null;
      setState({ status: "failed", progress: null });
    }
  })();
  return warming;
}

/** Tear the worker down and forget the prototypes. The HTTP cache keeps the model. */
export function disableLocal(): void {
  worker?.terminate();
  worker = null;
  protos = null;
  warming = null;
  pending.clear();
  setState({ status: "off", progress: null });
}

export interface LocalResult {
  ops: VoiceOp[];
  status: LocalStatus;
}

/**
 * Parse one utterance entirely in the browser. Never throws: a model that
 * failed to load, an unreadable answer, and an utterance below the confidence
 * bar all come back as zero ops, exactly as the remote tier does.
 */
export async function parseLocal(
  text: string,
  context: { labels: string[] },
): Promise<LocalResult> {
  const said = text.trim();
  if (said === "" || protos === null) return { ops: [], status: state.status };
  try {
    // `buildRequest` is called for its spans and its item list, not its
    // questions — the local answerer knows the question shape and fills it in
    // directly. Going through it anyway is deliberate: the spans on offer and
    // the items that may be chosen are then provably the same in both tiers,
    // including the deduping and the option cap, which `decode` checks against.
    const { spans, state: built } = buildRequest(said, context.labels.slice(0, 60));
    const raw = await answerLocally(said, built.existing_items, protos, embed);
    const { ops } = decode(raw, said, spans);
    // Belt and braces: `decode` only emits valid ops, but this tier is the one
    // with no server between it and the planner.
    return { ops: validateOps(ops), status: "ready" };
  } catch {
    return { ops: [], status: "failed" };
  }
}
