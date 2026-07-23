import type { DiagramEdge, DiagramNode, Doc } from "../types";
import { EMPTY_DOC } from "../types";

export interface Selection {
  kind: "node" | "edge";
  id: string;
}

export interface DocState {
  doc: Doc;
  /** Snapshot stack for undo; newest last. Snapshots share structure with
   * older docs because mutations always build fresh arrays/objects. */
  past: Doc[];
  selection: Selection | null;
}

export type DocAction =
  | { type: "add-node"; node: DiagramNode }
  | { type: "add-edge"; edge: DiagramEdge }
  | { type: "start-move"; id: string }
  | { type: "move-node"; id: string; x: number; y: number }
  | { type: "set-label"; id: string; label: string }
  | { type: "set-arrow"; id: string; arrow: boolean }
  | { type: "select"; selection: Selection | null }
  | { type: "delete-selection" }
  | { type: "undo" }
  | { type: "clear" }
  | { type: "load-sample" };

const UNDO_CAP = 100;

export const initialDocState: DocState = { doc: EMPTY_DOC, past: [], selection: null };

function push(past: Doc[], doc: Doc): Doc[] {
  const next = [...past, doc];
  return next.length > UNDO_CAP ? next.slice(next.length - UNDO_CAP) : next;
}

export function docReducer(state: DocState, action: DocAction): DocState {
  switch (action.type) {
    case "add-node":
      return {
        ...state,
        past: push(state.past, state.doc),
        doc: { ...state.doc, nodes: [...state.doc.nodes, action.node] },
      };

    case "add-edge":
      return {
        ...state,
        past: push(state.past, state.doc),
        doc: { ...state.doc, edges: [...state.doc.edges, action.edge] },
      };

    case "start-move":
      return {
        ...state,
        past: push(state.past, state.doc),
        selection: { kind: "node", id: action.id },
      };

    case "move-node":
      return {
        ...state,
        doc: {
          ...state.doc,
          nodes: state.doc.nodes.map((n) =>
            n.id === action.id ? { ...n, x: action.x, y: action.y } : n,
          ),
        },
      };

    case "set-label": {
      const target = state.doc.nodes.find((n) => n.id === action.id);
      if (!target || target.label === action.label) return state; // no-op: no undo entry
      return {
        ...state,
        past: push(state.past, state.doc),
        doc: {
          ...state.doc,
          nodes: state.doc.nodes.map((n) =>
            n.id === action.id ? { ...n, label: action.label } : n,
          ),
        },
      };
    }

    case "set-arrow": {
      const target = state.doc.edges.find((e) => e.id === action.id);
      if (!target || target.arrow === action.arrow) return state; // no-op: no undo entry
      return {
        ...state,
        past: push(state.past, state.doc),
        doc: {
          ...state.doc,
          edges: state.doc.edges.map((e) =>
            e.id === action.id ? { ...e, arrow: action.arrow } : e,
          ),
        },
      };
    }

    case "select":
      return { ...state, selection: action.selection };

    case "delete-selection": {
      const sel = state.selection;
      if (!sel) return state;
      let doc: Doc;
      if (sel.kind === "node") {
        doc = {
          nodes: state.doc.nodes.filter((n) => n.id !== sel.id),
          edges: state.doc.edges.filter(
            (e) =>
              !("node" in e.from && e.from.node === sel.id) &&
              !("node" in e.to && e.to.node === sel.id),
          ),
        };
      } else {
        doc = { ...state.doc, edges: state.doc.edges.filter((e) => e.id !== sel.id) };
      }
      return { doc, past: push(state.past, state.doc), selection: null };
    }

    case "undo": {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      return { doc: prev, past: state.past.slice(0, -1), selection: null };
    }

    case "clear":
      if (state.doc.nodes.length === 0 && state.doc.edges.length === 0) return state;
      return { doc: EMPTY_DOC, past: push(state.past, state.doc), selection: null };

    case "load-sample":
      return { doc: samplePathway(), past: push(state.past, state.doc), selection: null };
  }
}

/** A labeled 4-node example so the tool never has to open empty. */
export function samplePathway(): Doc {
  const nodes: DiagramNode[] = [
    { id: "sample_signal", type: "ellipse", x: 70, y: 220, w: 136, h: 76, label: "SIGNAL" },
    { id: "sample_filter", type: "rect", x: 300, y: 96, w: 150, h: 70, label: "FILTER" },
    { id: "sample_classify", type: "rect", x: 300, y: 352, w: 150, h: 70, label: "CLASSIFY" },
    { id: "sample_render", type: "ellipse", x: 560, y: 220, w: 144, h: 78, label: "RENDER" },
  ];
  const edges: DiagramEdge[] = [
    { id: "sample_e1", from: { node: "sample_signal" }, to: { node: "sample_filter" }, arrow: true },
    { id: "sample_e2", from: { node: "sample_signal" }, to: { node: "sample_classify" }, arrow: true },
    { id: "sample_e3", from: { node: "sample_filter" }, to: { node: "sample_render" }, arrow: true },
    { id: "sample_e4", from: { node: "sample_classify" }, to: { node: "sample_render" }, arrow: true },
  ];
  return { nodes, edges };
}
