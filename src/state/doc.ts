import type { DiagramEdge, DiagramNode, Doc } from "../types";
import { EMPTY_DOC, minSizeFor } from "../types";

export interface Selection {
  kind: "node" | "edge";
  id: string;
}

export interface DocState {
  doc: Doc;
  /** Undo snapshots, newest last. Snapshots share structure with older docs
   * because mutations always build fresh arrays/objects. */
  past: Doc[];
  /** Redo snapshots, populated by undo and cleared by any new mutation. */
  future: Doc[];
  selection: Selection | null;
}

export type DocAction =
  | { type: "add-node"; node: DiagramNode; select?: boolean }
  | { type: "add-edge"; edge: DiagramEdge }
  | { type: "start-move"; id: string }
  | { type: "move-node"; id: string; x: number; y: number }
  | { type: "resize-node"; id: string; x: number; y: number; w: number; h: number }
  | { type: "set-label"; id: string; label: string }
  | { type: "set-edge-label"; id: string; label: string }
  | { type: "set-fill"; id: string; fill: string }
  | { type: "set-arrow"; id: string; arrow: boolean }
  | { type: "select"; selection: Selection | null }
  | { type: "delete-selection" }
  | { type: "delete-node"; id: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "clear" }
  | { type: "load-doc"; doc: Doc }
  | { type: "load-sample" }
  /**
   * Swap in a document computed elsewhere, as one undo entry. Used by voice
   * commands, where a single utterance can add several nodes and edges at
   * once and must still undo in one step.
   */
  | { type: "replace-doc"; doc: Doc; selection: Selection | null };

const UNDO_CAP = 100;

export const initialDocState: DocState = {
  doc: EMPTY_DOC,
  past: [],
  future: [],
  selection: null,
};

function push(past: Doc[], doc: Doc): Doc[] {
  const next = [...past, doc];
  return next.length > UNDO_CAP ? next.slice(next.length - UNDO_CAP) : next;
}

/** Every new mutation invalidates the redo stack. */
function mutate(state: DocState, doc: Doc, selection = state.selection): DocState {
  return { doc, past: push(state.past, state.doc), future: [], selection };
}

function removeNode(doc: Doc, id: string): Doc {
  return {
    nodes: doc.nodes.filter((n) => n.id !== id),
    edges: doc.edges.filter(
      (e) => !("node" in e.from && e.from.node === id) && !("node" in e.to && e.to.node === id),
    ),
  };
}

export function docReducer(state: DocState, action: DocAction): DocState {
  switch (action.type) {
    case "add-node":
      return mutate(
        state,
        { ...state.doc, nodes: [...state.doc.nodes, action.node] },
        action.select ? { kind: "node", id: action.node.id } : state.selection,
      );

    case "add-edge":
      return mutate(state, { ...state.doc, edges: [...state.doc.edges, action.edge] });

    case "start-move":
      return {
        ...mutate(state, state.doc, { kind: "node", id: action.id }),
        doc: state.doc,
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

    case "resize-node":
      return {
        ...state,
        doc: {
          ...state.doc,
          nodes: state.doc.nodes.map((n) => {
            if (n.id !== action.id) return n;
            const min = minSizeFor(n.type);
            return {
              ...n,
              x: action.x,
              y: action.y,
              w: Math.max(min.w, action.w),
              h: Math.max(min.h, action.h),
            };
          }),
        },
      };

    case "set-label": {
      const target = state.doc.nodes.find((n) => n.id === action.id);
      if (!target || target.label === action.label) return state; // no-op: no undo entry
      return mutate(state, {
        ...state.doc,
        nodes: state.doc.nodes.map((n) => (n.id === action.id ? { ...n, label: action.label } : n)),
      });
    }

    case "set-edge-label": {
      const target = state.doc.edges.find((e) => e.id === action.id);
      if (!target || (target.label ?? "") === action.label) return state;
      return mutate(state, {
        ...state.doc,
        edges: state.doc.edges.map((e) =>
          e.id === action.id
            ? action.label
              ? { ...e, label: action.label }
              : (({ label: _drop, ...rest }) => rest)(e)
            : e,
        ),
      });
    }

    case "set-fill": {
      // "" clears the stored fill so the node follows the theme again.
      const target = state.doc.nodes.find((n) => n.id === action.id);
      if (!target || (target.fill ?? "") === action.fill) return state;
      return mutate(state, {
        ...state.doc,
        nodes: state.doc.nodes.map((n) =>
          n.id === action.id
            ? action.fill
              ? { ...n, fill: action.fill }
              : (({ fill: _drop, ...rest }) => rest)(n)
            : n,
        ),
      });
    }

    case "set-arrow": {
      const target = state.doc.edges.find((e) => e.id === action.id);
      if (!target || target.arrow === action.arrow) return state;
      return mutate(state, {
        ...state.doc,
        edges: state.doc.edges.map((e) => (e.id === action.id ? { ...e, arrow: action.arrow } : e)),
      });
    }

    case "select":
      return { ...state, selection: action.selection };

    case "delete-selection": {
      const sel = state.selection;
      if (!sel) return state;
      const doc =
        sel.kind === "node"
          ? removeNode(state.doc, sel.id)
          : { ...state.doc, edges: state.doc.edges.filter((e) => e.id !== sel.id) };
      return mutate(state, doc, null);
    }

    case "delete-node": {
      if (!state.doc.nodes.some((n) => n.id === action.id)) return state;
      const selection = state.selection?.id === action.id ? null : state.selection;
      return mutate(state, removeNode(state.doc, action.id), selection);
    }

    case "undo": {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      return {
        doc: prev,
        past: state.past.slice(0, -1),
        future: [...state.future, state.doc],
        selection: null,
      };
    }

    case "redo": {
      const next = state.future[state.future.length - 1];
      if (!next) return state;
      return {
        doc: next,
        past: push(state.past, state.doc),
        future: state.future.slice(0, -1),
        selection: null,
      };
    }

    case "clear":
      if (state.doc.nodes.length === 0 && state.doc.edges.length === 0) return state;
      return mutate(state, EMPTY_DOC, null);

    case "load-doc":
      return mutate(state, action.doc, null);

    case "load-sample":
      return mutate(state, samplePathway(), null);

    case "replace-doc":
      // An unchanged document must not burn an undo slot — a command that only
      // moved the selection should not be undoable as a document edit.
      if (action.doc === state.doc) {
        return state.selection === action.selection
          ? state
          : { ...state, selection: action.selection };
      }
      return mutate(state, action.doc, action.selection);
  }
}

/** A labeled example so the tool never has to open empty. */
export function samplePathway(): Doc {
  const nodes: DiagramNode[] = [
    { id: "sample_signal", type: "ellipse", x: 55, y: 225, w: 136, h: 76, label: "SIGNAL", fill: "#eef2fb" },
    { id: "sample_prep", type: "hexagon", x: 268, y: 92, w: 168, h: 84, label: "PREP" },
    { id: "sample_gate", type: "diamond", x: 268, y: 352, w: 170, h: 96, label: "PASS?" },
    { id: "sample_filter", type: "rect", x: 512, y: 98, w: 150, h: 70, label: "FILTER" },
    { id: "sample_render", type: "ellipse", x: 520, y: 360, w: 144, h: 78, label: "RENDER", fill: "#e8f1ec" },
    { id: "sample_store", type: "cylinder", x: 770, y: 214, w: 132, h: 112, label: "STORE", fill: "#fdf2e7" },
    { id: "sample_note", type: "text", x: 330, y: 512, w: 220, h: 36, label: "sketched with plexus" },
  ];
  const edges: DiagramEdge[] = [
    { id: "sample_e1", from: { node: "sample_signal" }, to: { node: "sample_prep" }, arrow: true },
    { id: "sample_e2", from: { node: "sample_signal" }, to: { node: "sample_gate" }, arrow: true },
    { id: "sample_e3", from: { node: "sample_prep" }, to: { node: "sample_filter" }, arrow: true },
    { id: "sample_e4", from: { node: "sample_gate" }, to: { node: "sample_render" }, arrow: true, label: "yes" },
    { id: "sample_e5", from: { node: "sample_filter" }, to: { node: "sample_store" }, arrow: true },
    { id: "sample_e6", from: { node: "sample_render" }, to: { node: "sample_store" }, arrow: true },
  ];
  return { nodes, edges };
}
