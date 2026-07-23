import type { DiagramEdge, DiagramNode, Doc, EdgeEnd } from "../types";

/**
 * Persistence: debounced autosave to localStorage (schema-versioned) plus
 * .json file save/open. Validation is strict — a corrupt or foreign payload
 * loads as null rather than poisoning the editor state.
 */

const STORAGE_KEY = "plexus.doc.v2";
const SCHEMA_VERSION = 2;

const NODE_TYPES = new Set(["rect", "ellipse", "diamond", "text"]);

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function validEnd(x: unknown): x is EdgeEnd {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.node === "string") return true;
  return isFiniteNumber(o.x) && isFiniteNumber(o.y);
}

function validNode(x: unknown): x is DiagramNode {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.type === "string" &&
    NODE_TYPES.has(o.type) &&
    isFiniteNumber(o.x) &&
    isFiniteNumber(o.y) &&
    isFiniteNumber(o.w) &&
    isFiniteNumber(o.h) &&
    typeof o.label === "string" &&
    (o.fill === undefined || typeof o.fill === "string")
  );
}

function validEdge(x: unknown): x is DiagramEdge {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    validEnd(o.from) &&
    validEnd(o.to) &&
    typeof o.arrow === "boolean" &&
    (o.label === undefined || typeof o.label === "string")
  );
}

/** Structurally validate an untrusted payload into a Doc, or reject it. */
export function validateDoc(x: unknown): Doc | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.nodes) || !Array.isArray(o.edges)) return null;
  if (!o.nodes.every(validNode) || !o.edges.every(validEdge)) return null;
  const nodes = o.nodes as DiagramNode[];
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) return null;
  const edges = (o.edges as DiagramEdge[]).filter(
    (e) =>
      (!("node" in e.from) || ids.has(e.from.node)) && (!("node" in e.to) || ids.has(e.to.node)),
  );
  return { nodes, edges };
}

export function docToJson(doc: Doc): string {
  return JSON.stringify({ v: SCHEMA_VERSION, doc }, null, 2);
}

export function parseDocJson(text: string): Doc | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    // Accept the wrapped {v, doc} shape and, leniently, a bare Doc.
    return validateDoc("doc" in o ? o.doc : parsed);
  } catch {
    return null;
  }
}

export function saveLocal(doc: Doc): void {
  try {
    localStorage.setItem(STORAGE_KEY, docToJson(doc));
  } catch {
    /* quota exceeded or storage disabled — autosave is best-effort */
  }
}

export function loadLocal(): Doc | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseDocJson(raw) : null;
  } catch {
    return null;
  }
}

export function downloadDocJson(doc: Doc, filename = "plexus.json"): void {
  const blob = new Blob([docToJson(doc)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
