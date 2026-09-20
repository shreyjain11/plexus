import type { DiagramEdge, DiagramNode, Doc, NodeType } from "../types";
import { DEFAULT_NODE_SIZE, isNodeRef } from "../types";
import type { Selection } from "../state/doc";
import { textNodeWidth } from "../recognition/compose";
import { fuzzyScore } from "../util/fuzzy";
import { shapeFromWord, titleCase } from "./grammar";
import { placeNode, tidyLayout } from "./layout";
import type { Target, VoiceOp } from "./ops";

/**
 * The planner: `VoiceOp[]` + the current document → the document that should
 * replace it, plus the side effects the shell has to run.
 *
 * It is deliberately a pure function rather than a pile of dispatches. One
 * utterance produces exactly one new `Doc`, which the app commits as a single
 * undo entry — say "add three boxes and connect them" and one ⌘Z takes it all
 * back. It also means the whole command surface is unit-testable without a
 * browser, a microphone, or React.
 */

/** Mirrors `Mode` in components/Canvas.tsx; redeclared to keep this pure. */
export type VoiceMode = "draw" | "select" | "text" | "write";

/** Things the planner cannot do itself, handed back for the shell to run. */
export type Effect =
  | { kind: "mode"; mode: VoiceMode }
  | { kind: "arrows"; on: boolean }
  | { kind: "theme"; theme: "light" | "dark" }
  | { kind: "zoom"; dir: "in" | "out" | "reset" }
  | { kind: "export"; format: "svg" | "png" }
  | { kind: "file"; action: "save" | "open" }
  | { kind: "history"; action: "undo" | "redo" }
  | { kind: "canvas"; action: "clear" | "sample" }
  | { kind: "help" };

export interface PlanContext {
  doc: Doc;
  selection: Selection | null;
  /** Whether new edges get an arrowhead when the utterance does not say. */
  arrowDefault: boolean;
  /** Injected so tests can produce stable ids. */
  newId: (prefix: string) => string;
}

export interface Plan {
  /** The new document; referentially equal to `ctx.doc` when nothing changed. */
  doc: Doc;
  selection: Selection | null;
  effects: Effect[];
  /** Short human summaries of what was done, newest last. */
  notes: string[];
  /** What could not be done, e.g. a name that matched no node. */
  problems: string[];
  /** Ids of newly created nodes, so the shell can pulse them. */
  added: string[];
}

/** Label size used when a node is created by voice rather than drawn. */
const VOICE_FONT_SIZE = 15;
const MAX_AUTO_WIDTH = 380;

function sizeFor(type: NodeType, label: string): { w: number; h: number } {
  const base = DEFAULT_NODE_SIZE[type];
  if (type === "text") {
    return { w: Math.max(base.w, Math.round(textNodeWidth(label, VOICE_FONT_SIZE))), h: base.h };
  }
  // Grow a little for long labels so the text is not clipped on creation.
  const needed = Math.round(label.length * 8.6 + 40);
  return { w: Math.min(MAX_AUTO_WIDTH, Math.max(base.w, needed)), h: base.h };
}

function quote(s: string): string {
  return s.trim() === "" ? "" : ` “${s.trim()}”`;
}

const SHAPE_NAME: Record<NodeType, string> = {
  rect: "box",
  ellipse: "ellipse",
  diamond: "diamond",
  triangle: "triangle",
  hexagon: "hexagon",
  parallelogram: "parallelogram",
  cylinder: "database",
  text: "text",
};

/** Accept a fuzzy hit only when it scores close to a perfect self-match. */
const FUZZY_RATIO = 0.4;

class Planner {
  private nodes: DiagramNode[];
  private edges: DiagramEdge[];
  private selection: Selection | null;
  private lastTouched: string | null = null;
  private docTouched = false;
  /** Set once a whole-document effect (undo, clear, …) has been queued. */
  private wholeDoc = false;

  readonly effects: Effect[] = [];
  readonly notes: string[] = [];
  readonly problems: string[] = [];
  readonly added: string[] = [];

  constructor(private readonly ctx: PlanContext) {
    this.nodes = [...ctx.doc.nodes];
    this.edges = [...ctx.doc.edges];
    this.selection = ctx.selection;
  }

  // --- resolution -----------------------------------------------------------

  private byId(id: string): DiagramNode | null {
    return this.nodes.find((n) => n.id === id) ?? null;
  }

  /** The node a bare "it" refers to: the selection, else the last one touched. */
  private implicitNode(): DiagramNode | null {
    if (this.selection?.kind === "node") {
      const n = this.byId(this.selection.id);
      if (n) return n;
    }
    if (this.lastTouched) {
      const n = this.byId(this.lastTouched);
      if (n) return n;
    }
    return this.nodes[this.nodes.length - 1] ?? null;
  }

  /**
   * Resolve a spoken name to a node. Later nodes win ties, because "the box"
   * almost always means the one just made.
   */
  resolve(target: Target | undefined): DiagramNode | null {
    if (target === undefined) return this.implicitNode();
    const q = target.trim().toLowerCase();
    if (q === "") return this.implicitNode();

    const labels = this.nodes.map((n) => n.label.trim().toLowerCase());

    for (let i = this.nodes.length - 1; i >= 0; i--) if (labels[i] === q) return this.nodes[i]!;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const l = labels[i]!;
      if (l !== "" && (l.startsWith(q) || q.startsWith(l))) return this.nodes[i]!;
    }
    // Every spoken word appears in the label — tolerant but not sloppy.
    const qWords = q.split(" ").filter((w) => w.length > 1);
    if (qWords.length > 0) {
      for (let i = this.nodes.length - 1; i >= 0; i--) {
        const l = labels[i]!;
        if (l !== "" && qWords.every((w) => l.includes(w))) return this.nodes[i]!;
      }
    }
    // "the database" with nothing labelled that way → the newest cylinder.
    const shape = shapeFromWord(q);
    if (shape) {
      for (let i = this.nodes.length - 1; i >= 0; i--) {
        if (this.nodes[i]!.type === shape) return this.nodes[i]!;
      }
    }
    // Last resort: subsequence match, gated on a score near a perfect one.
    if (q.length >= 3) {
      const perfect = fuzzyScore(q, q);
      if (perfect !== null && perfect > 0) {
        let best: DiagramNode | null = null;
        let bestScore = perfect * FUZZY_RATIO;
        for (const n of this.nodes) {
          const s = n.label.trim() === "" ? null : fuzzyScore(q, n.label);
          if (s !== null && s >= bestScore) {
            bestScore = s;
            best = n;
          }
        }
        if (best) return best;
      }
    }
    return null;
  }

  private touch(id: string): void {
    this.lastTouched = id;
  }

  private edit(): void {
    this.docTouched = true;
  }

  // --- document mutations ---------------------------------------------------

  createNode(type: NodeType, label: string, anchor: DiagramNode | null): DiagramNode {
    const size = sizeFor(type, label);
    const spot = placeNode({ nodes: this.nodes, edges: this.edges }, size, anchor);
    const node: DiagramNode = {
      id: this.ctx.newId("n"),
      type,
      x: spot.x,
      y: spot.y,
      w: size.w,
      h: size.h,
      label,
      ...(type === "text" ? { fontSize: VOICE_FONT_SIZE } : {}),
    };
    this.nodes = [...this.nodes, node];
    this.added.push(node.id);
    this.selection = { kind: "node", id: node.id };
    this.touch(node.id);
    this.edit();
    return node;
  }

  private replaceNode(id: string, patch: Partial<DiagramNode>): void {
    this.nodes = this.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
    this.touch(id);
    this.edit();
  }

  private removeNode(id: string): void {
    this.nodes = this.nodes.filter((n) => n.id !== id);
    this.edges = this.edges.filter(
      (e) => !(isNodeRef(e.from) && e.from.node === id) && !(isNodeRef(e.to) && e.to.node === id),
    );
    if (this.selection?.id === id) this.selection = null;
    if (this.lastTouched === id) this.lastTouched = null;
    this.edit();
  }

  private findEdge(from: string, to: string): DiagramEdge | null {
    return (
      this.edges.find(
        (e) => isNodeRef(e.from) && e.from.node === from && isNodeRef(e.to) && e.to.node === to,
      ) ?? null
    );
  }

  // --- op dispatch ----------------------------------------------------------

  /**
   * Whole-document ops (undo, clear, load sample) cannot be interleaved with
   * edits — the edits would be computed against a document that the effect is
   * about to throw away. The grammar never mixes them; a model might.
   */
  private guardWholeDoc(what: string): boolean {
    if (this.docTouched) {
      this.problems.push(`${what} has to be said on its own`);
      return false;
    }
    this.wholeDoc = true;
    return true;
  }

  apply(op: VoiceOp): void {
    if (this.wholeDoc && op.op !== "help") {
      this.problems.push("say that as a separate command");
      return;
    }

    switch (op.op) {
      case "add": {
        const anchor = op.near !== undefined ? this.resolve(op.near) : null;
        if (op.near !== undefined && !anchor) this.problems.push(`no node called “${op.near}”`);
        const node = this.createNode(op.shape, op.label ?? "", anchor);
        this.notes.push(`Added ${SHAPE_NAME[op.shape]}${quote(node.label)}`);
        return;
      }

      case "connect": {
        // Unknown names become new nodes: "connect intake to review to ship"
        // should build the chain, not complain three times.
        const resolved: DiagramNode[] = [];
        for (const name of op.chain) {
          const found = this.resolve(name);
          if (found) {
            resolved.push(found);
          } else {
            const anchor = resolved[resolved.length - 1] ?? null;
            const made = this.createNode("rect", titleCase(name), anchor);
            resolved.push(made);
            this.notes.push(`Added box${quote(made.label)}`);
          }
        }
        let linked = 0;
        for (let i = 0; i + 1 < resolved.length; i++) {
          const a = resolved[i]!;
          const b = resolved[i + 1]!;
          if (a.id === b.id) continue;
          const existing = this.findEdge(a.id, b.id);
          if (existing) {
            if (op.label !== undefined && (existing.label ?? "") !== op.label) {
              this.edges = this.edges.map((e) =>
                e.id === existing.id ? { ...e, label: op.label! } : e,
              );
              this.edit();
            }
            continue;
          }
          const edge: DiagramEdge = {
            id: this.ctx.newId("e"),
            from: { node: a.id },
            to: { node: b.id },
            arrow: op.arrow ?? this.ctx.arrowDefault,
            ...(op.label !== undefined && op.label !== "" ? { label: op.label } : {}),
          };
          this.edges = [...this.edges, edge];
          this.selection = { kind: "edge", id: edge.id };
          this.edit();
          linked++;
        }
        if (linked > 0) {
          const names = resolved.map((n) => n.label.trim() || SHAPE_NAME[n.type]);
          this.notes.push(`Connected ${names.join(" → ")}`);
        } else if (resolved.length >= 2) {
          this.notes.push("Already connected");
        }
        return;
      }

      case "rename": {
        if (op.target === undefined && this.selection?.kind === "edge") {
          const id = this.selection.id;
          this.edges = this.edges.map((e) =>
            e.id === id ? (op.label ? { ...e, label: op.label } : stripLabel(e)) : e,
          );
          this.edit();
          this.notes.push(op.label ? `Labelled the edge${quote(op.label)}` : "Cleared the edge label");
          return;
        }
        const node = this.resolve(op.target);
        if (!node) return this.missing(op.target);
        this.replaceNode(node.id, { label: op.label });
        this.selection = { kind: "node", id: node.id };
        this.notes.push(op.label ? `Renamed to${quote(op.label)}` : "Cleared the label");
        return;
      }

      case "fill": {
        const node = this.resolve(op.target);
        if (!node) return this.missing(op.target);
        if ((node.fill ?? "") === op.color) {
          this.notes.push("Already that colour");
          return;
        }
        // "" means "follow the theme", which is the absence of a fill.
        const next = op.color === "" ? stripFill(node) : { ...node, fill: op.color };
        this.nodes = this.nodes.map((n) => (n.id === node.id ? next : n));
        this.touch(node.id);
        this.edit();
        this.notes.push(op.color === "" ? "Cleared the fill" : "Recoloured");
        return;
      }

      case "delete": {
        if (op.target === undefined && this.selection?.kind === "edge") {
          const id = this.selection.id;
          this.edges = this.edges.filter((e) => e.id !== id);
          this.selection = null;
          this.edit();
          this.notes.push("Deleted the edge");
          return;
        }
        const node = this.resolve(op.target);
        if (!node) return this.missing(op.target);
        this.removeNode(node.id);
        this.notes.push(`Deleted ${SHAPE_NAME[node.type]}${quote(node.label)}`);
        return;
      }

      case "select": {
        const node = this.resolve(op.target);
        if (!node) return this.missing(op.target);
        this.selection = { kind: "node", id: node.id };
        this.touch(node.id);
        this.notes.push(`Selected${quote(node.label) || ` the ${SHAPE_NAME[node.type]}`}`);
        return;
      }

      case "duplicate": {
        const node = this.resolve(op.target);
        if (!node) return this.missing(op.target);
        const spot = placeNode({ nodes: this.nodes, edges: this.edges }, node, node);
        const copy: DiagramNode = { ...node, id: this.ctx.newId("n"), x: spot.x, y: spot.y };
        this.nodes = [...this.nodes, copy];
        this.added.push(copy.id);
        this.selection = { kind: "node", id: copy.id };
        this.touch(copy.id);
        this.edit();
        this.notes.push(`Duplicated${quote(node.label)}`);
        return;
      }

      case "move": {
        const node = this.resolve(op.target);
        if (!node) return this.missing(op.target);
        this.replaceNode(node.id, { x: node.x + op.dx, y: node.y + op.dy });
        this.selection = { kind: "node", id: node.id };
        this.notes.push("Moved it");
        return;
      }

      case "tidy": {
        const tidied = tidyLayout({ nodes: this.nodes, edges: this.edges });
        if (tidied.nodes === this.nodes) {
          this.notes.push("Already tidy");
          return;
        }
        this.nodes = tidied.nodes;
        this.edit();
        this.notes.push("Tidied the layout");
        return;
      }

      case "history":
        if (!this.guardWholeDoc(op.action === "undo" ? "Undo" : "Redo")) return;
        this.effects.push({ kind: "history", action: op.action });
        this.notes.push(op.action === "undo" ? "Undone" : "Redone");
        return;

      case "canvas":
        if (!this.guardWholeDoc(op.action === "clear" ? "Clearing" : "Loading the sample")) return;
        this.effects.push({ kind: "canvas", action: op.action });
        this.notes.push(op.action === "clear" ? "Cleared the canvas" : "Loaded the sample");
        return;

      case "mode":
        this.effects.push({ kind: "mode", mode: op.mode });
        this.notes.push(`${op.mode} mode`);
        return;

      case "arrows":
        this.effects.push({ kind: "arrows", on: op.on });
        this.notes.push(op.on ? "Arrows on" : "Plain lines");
        return;

      case "theme":
        this.effects.push({ kind: "theme", theme: op.theme });
        this.notes.push(`${op.theme} theme`);
        return;

      case "zoom":
        this.effects.push({ kind: "zoom", dir: op.dir });
        this.notes.push(op.dir === "reset" ? "Zoom reset" : `Zoomed ${op.dir}`);
        return;

      case "export":
        this.effects.push({ kind: "export", format: op.format });
        this.notes.push(`Exporting ${op.format.toUpperCase()}`);
        return;

      case "file":
        this.effects.push({ kind: "file", action: op.action });
        this.notes.push(op.action === "save" ? "Saving" : "Opening a file");
        return;

      case "help":
        this.effects.push({ kind: "help" });
        this.notes.push("Showing the shortcuts");
        return;
    }
  }

  private missing(target: Target | undefined): void {
    this.problems.push(
      target === undefined ? "nothing is selected" : `no node called “${target}”`,
    );
  }

  finish(): Plan {
    return {
      doc: this.docTouched ? { nodes: this.nodes, edges: this.edges } : this.ctx.doc,
      selection: this.selection,
      effects: this.effects,
      notes: this.notes,
      problems: this.problems,
      added: this.added,
    };
  }
}

function stripFill(node: DiagramNode): DiagramNode {
  const { fill: _drop, ...rest } = node;
  return rest;
}

function stripLabel(edge: DiagramEdge): DiagramEdge {
  const { label: _drop, ...rest } = edge;
  return rest;
}

/** Apply a batch of ops to a document. Pure: `ctx` is never mutated. */
export function planOps(ops: readonly VoiceOp[], ctx: PlanContext): Plan {
  const planner = new Planner(ctx);
  for (const op of ops) planner.apply(op);
  return planner.finish();
}

/** Whether a plan actually did anything worth reporting. */
export function isNoop(plan: Plan, ctx: PlanContext): boolean {
  return (
    plan.doc === ctx.doc &&
    plan.effects.length === 0 &&
    plan.selection === ctx.selection &&
    plan.notes.length === 0
  );
}
