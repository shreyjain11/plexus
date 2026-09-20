import type { NodeType } from "../types";

/**
 * The voice op vocabulary — the single contract between *every* way a command
 * can be produced (the offline grammar, the optional LLM route, a future
 * scripting API) and the one planner that applies it.
 *
 * Deliberately small and flat: each op is a plain JSON object, so the same
 * validator guards a locally-parsed op and an op that arrived as untrusted
 * JSON from a model. Nothing here touches the DOM or React — this module is
 * imported by the serverless route as well as the browser.
 */

/** A spoken reference to a node: a label, "it"/"that", or a bare shape word. */
export type Target = string;

export type VoiceOp =
  /** Create a node. `near` biases placement toward an existing node. */
  | { op: "add"; shape: NodeType; label?: string | undefined; near?: Target | undefined }
  /** Connect an ordered run of nodes: [a,b,c] becomes a→b and b→c. */
  | { op: "connect"; chain: Target[]; label?: string | undefined; arrow?: boolean | undefined }
  | { op: "rename"; target?: Target | undefined; label: string }
  | { op: "fill"; target?: Target | undefined; color: string }
  | { op: "delete"; target?: Target | undefined }
  | { op: "select"; target: Target }
  | { op: "duplicate"; target?: Target | undefined }
  | { op: "move"; target?: Target | undefined; dx: number; dy: number }
  /** Re-layout the whole diagram as left-to-right layers. */
  | { op: "tidy" }
  | { op: "mode"; mode: "draw" | "select" | "text" | "write" }
  | { op: "arrows"; on: boolean }
  | { op: "theme"; theme: "light" | "dark" }
  | { op: "zoom"; dir: "in" | "out" | "reset" }
  | { op: "export"; format: "svg" | "png" }
  | { op: "file"; action: "save" | "open" }
  | { op: "history"; action: "undo" | "redo" }
  | { op: "canvas"; action: "clear" | "sample" }
  | { op: "help" };

export const NODE_TYPES: readonly NodeType[] = [
  "rect",
  "ellipse",
  "diamond",
  "triangle",
  "hexagon",
  "parallelogram",
  "cylinder",
  "text",
];

/**
 * Ops that act on history or replace the whole document. They are planned as
 * side effects rather than document edits, so an utterance mixing one of them
 * with document edits would have ambiguous ordering — the grammar only ever
 * emits them alone, and `planOps` drops any that follow a document edit.
 */
export const WHOLE_DOC_OPS: ReadonlySet<string> = new Set(["history", "canvas"]);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(x: unknown): string | null {
  return typeof x === "string" && x.trim() !== "" ? x.trim() : null;
}

function oneOf<T extends string>(x: unknown, allowed: readonly T[]): T | null {
  return typeof x === "string" && (allowed as readonly string[]).includes(x) ? (x as T) : null;
}

function finite(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** Labels are single-line and bounded — a model cannot stuff a novel into one. */
const MAX_LABEL = 120;
const MAX_CHAIN = 24;

function label(x: unknown): string | null {
  const s = str(x);
  if (s === null) return null;
  const clean = s.replace(/\s+/g, " ").slice(0, MAX_LABEL);
  return clean === "" ? null : clean;
}

/**
 * Validate one untrusted object into a VoiceOp, or reject it. Unknown ops,
 * missing required fields, and out-of-vocabulary enum values all return null
 * rather than throwing, so one bad op in a batch never loses the good ones.
 */
export function validateOp(x: unknown): VoiceOp | null {
  if (!isRecord(x)) return null;
  switch (x.op) {
    case "add": {
      const shape = oneOf(x.shape, NODE_TYPES);
      if (!shape) return null;
      const l = label(x.label);
      const near = str(x.near);
      return {
        op: "add",
        shape,
        ...(l !== null ? { label: l } : {}),
        ...(near !== null ? { near } : {}),
      };
    }
    case "connect": {
      if (!Array.isArray(x.chain)) return null;
      const chain = x.chain.map(str).filter((s): s is string => s !== null);
      if (chain.length < 2) return null;
      const l = label(x.label);
      return {
        op: "connect",
        chain: chain.slice(0, MAX_CHAIN),
        ...(l !== null ? { label: l } : {}),
        ...(typeof x.arrow === "boolean" ? { arrow: x.arrow } : {}),
      };
    }
    case "rename": {
      // An empty label is meaningful here: it clears the label.
      if (typeof x.label !== "string") return null;
      const target = str(x.target);
      return {
        op: "rename",
        label: x.label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL),
        ...(target !== null ? { target } : {}),
      };
    }
    case "fill": {
      if (typeof x.color !== "string") return null;
      // "" is the documented "auto — follow the theme" fill.
      const color = x.color.trim();
      if (color !== "" && !/^#[0-9a-f]{3,8}$/i.test(color)) return null;
      const target = str(x.target);
      return { op: "fill", color, ...(target !== null ? { target } : {}) };
    }
    case "delete":
    case "duplicate": {
      const target = str(x.target);
      return { op: x.op, ...(target !== null ? { target } : {}) };
    }
    case "select": {
      const target = str(x.target);
      return target ? { op: "select", target } : null;
    }
    case "move": {
      const dx = finite(x.dx);
      const dy = finite(x.dy);
      if (dx === null || dy === null) return null;
      const target = str(x.target);
      const clamp = (n: number) => Math.max(-4000, Math.min(4000, Math.round(n)));
      return { op: "move", dx: clamp(dx), dy: clamp(dy), ...(target !== null ? { target } : {}) };
    }
    case "tidy":
      return { op: "tidy" };
    case "help":
      return { op: "help" };
    case "mode": {
      const mode = oneOf(x.mode, ["draw", "select", "text", "write"] as const);
      return mode ? { op: "mode", mode } : null;
    }
    case "arrows":
      return typeof x.on === "boolean" ? { op: "arrows", on: x.on } : null;
    case "theme": {
      const theme = oneOf(x.theme, ["light", "dark"] as const);
      return theme ? { op: "theme", theme } : null;
    }
    case "zoom": {
      const dir = oneOf(x.dir, ["in", "out", "reset"] as const);
      return dir ? { op: "zoom", dir } : null;
    }
    case "export": {
      const format = oneOf(x.format, ["svg", "png"] as const);
      return format ? { op: "export", format } : null;
    }
    case "file": {
      const action = oneOf(x.action, ["save", "open"] as const);
      return action ? { op: "file", action } : null;
    }
    case "history": {
      const action = oneOf(x.action, ["undo", "redo"] as const);
      return action ? { op: "history", action } : null;
    }
    case "canvas": {
      const action = oneOf(x.action, ["clear", "sample"] as const);
      return action ? { op: "canvas", action } : null;
    }
    default:
      return null;
  }
}

/** Validate a batch, dropping anything malformed. Caps the batch length. */
export function validateOps(x: unknown, max = 24): VoiceOp[] {
  if (!Array.isArray(x)) return [];
  const out: VoiceOp[] = [];
  for (const raw of x) {
    const op = validateOp(raw);
    if (op) out.push(op);
    if (out.length >= max) break;
  }
  return out;
}
