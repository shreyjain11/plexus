import { describe, expect, it } from "vitest";
import { parseClause, parseNumber, parseUtterance, splitClauses } from "../src/voice/grammar";
import { validateOp, validateOps, type VoiceOp } from "../src/voice/ops";
import { placeNode, tidyLayout, PLACE_GAP } from "../src/voice/layout";
import { planOps, type PlanContext } from "../src/voice/plan";
import { docReducer, initialDocState } from "../src/state/doc";
import type { DiagramEdge, DiagramNode, Doc } from "../src/types";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const node = (over: Partial<DiagramNode> & { id: string }): DiagramNode => ({
  type: "rect",
  x: 0,
  y: 0,
  w: 160,
  h: 100,
  label: "",
  ...over,
});

const edge = (id: string, from: string, to: string, over: Partial<DiagramEdge> = {}): DiagramEdge => ({
  id,
  from: { node: from },
  to: { node: to },
  arrow: true,
  ...over,
});

/** Deterministic ids so plans can be asserted exactly. */
function idFactory(): (prefix: string) => string {
  let n = 0;
  return (prefix) => `${prefix}${++n}`;
}

function ctx(doc: Doc, over: Partial<PlanContext> = {}): PlanContext {
  return { doc, selection: null, arrowDefault: true, newId: idFactory(), ...over };
}

/** Parse + plan in one step, the way the app does. */
function say(text: string, doc: Doc = { nodes: [], edges: [] }, over: Partial<PlanContext> = {}) {
  const c = ctx(doc, over);
  const { ops, unparsed } = parseUtterance(text);
  return { ...planOps(ops, c), ops, unparsed, ctx: c };
}

const only = (text: string): VoiceOp[] => parseClause(text) ?? [];

// ---------------------------------------------------------------------------
// grammar
// ---------------------------------------------------------------------------

describe("grammar — utterance splitting", () => {
  it("splits on strong separators but never on a bare 'and'", () => {
    expect(splitClauses("add a box. then connect a to b")).toEqual([
      "add a box",
      "connect a to b",
    ]);
    expect(splitClauses("connect a and b")).toEqual(["connect a and b"]);
    expect(splitClauses("undo; redo")).toEqual(["undo", "redo"]);
  });

  it("reads counts as digits or words", () => {
    expect(parseNumber("3")).toBe(3);
    expect(parseNumber("three")).toBe(3);
    expect(parseNumber("twenty five")).toBe(25);
    expect(parseNumber("banana")).toBeNull();
  });
});

describe("grammar — creating nodes", () => {
  it("defaults to a rectangle and reads the label after a naming word", () => {
    expect(only("add a box called signal")).toEqual([{ op: "add", shape: "rect", label: "Signal" }]);
    expect(only("create signal")).toEqual([{ op: "add", shape: "rect", label: "Signal" }]);
  });

  it("maps flowchart role words onto shapes", () => {
    expect(only("add a decision")[0]).toMatchObject({ op: "add", shape: "diamond" });
    expect(only("add a database called store")[0]).toMatchObject({ op: "add", shape: "cylinder" });
    expect(only("new circle")[0]).toMatchObject({ op: "add", shape: "ellipse" });
    expect(only("insert an input output")[0]).toMatchObject({ op: "add", shape: "parallelogram" });
    expect(only("add a note saying hello")[0]).toMatchObject({ op: "add", shape: "text", label: "Hello" });
  });

  it("expands a count into numbered nodes", () => {
    const ops = only("add three boxes called step");
    expect(ops).toHaveLength(3);
    expect(ops.map((o) => (o.op === "add" ? o.label : null))).toEqual(["Step 1", "Step 2", "Step 3"]);
  });

  it("takes a leading colour and a trailing placement", () => {
    expect(only("add a blue box called signal near prep")).toEqual([
      { op: "add", shape: "rect", label: "Signal", near: "prep" },
      { op: "fill", color: "#eef2fb" },
    ]);
  });

  it("does not mistake a colour-named node for a colour", () => {
    expect(only("add a box called blue")).toEqual([{ op: "add", shape: "rect", label: "Blue" }]);
  });
});

describe("grammar — connecting nodes", () => {
  it("handles to-chains, and-chains, and edge labels", () => {
    expect(only("connect signal to prep")).toEqual([{ op: "connect", chain: ["signal", "prep"] }]);
    expect(only("connect signal and prep")).toEqual([{ op: "connect", chain: ["signal", "prep"] }]);
    expect(only("connect a to b to c")[0]).toMatchObject({ chain: ["a", "b", "c"] });
    expect(only("arrow from pass to render labeled yes")).toEqual([
      { op: "connect", chain: ["pass", "render"], label: "Yes", arrow: true },
    ]);
  });

  it("distinguishes drawing a line from drawing a shape", () => {
    expect(only("draw a line from a to b")).toEqual([
      { op: "connect", chain: ["a", "b"], arrow: false },
    ]);
    expect(only("draw a box")).toEqual([{ op: "add", shape: "rect" }]);
  });

  it("rejects a connect with nothing to connect", () => {
    expect(parseClause("connect")).toBeNull();
    expect(parseClause("connect signal")).toBeNull();
  });
});

describe("grammar — editing and app control", () => {
  it("parses rename, fill, delete, select, duplicate and move", () => {
    expect(only("rename store to archive")).toEqual([
      { op: "rename", target: "store", label: "Archive" },
    ]);
    expect(only("call it kinase")).toEqual([{ op: "rename", label: "Kinase" }]);
    expect(only("make it blue")).toEqual([{ op: "fill", color: "#eef2fb" }]);
    expect(only("fill store orange")).toEqual([{ op: "fill", color: "#fdf2e7", target: "store" }]);
    expect(only("delete that")).toEqual([{ op: "delete" }]);
    expect(only("select the gate")).toEqual([{ op: "select", target: "gate" }]);
    expect(only("duplicate")).toEqual([{ op: "duplicate" }]);
    expect(only("move it right 120")).toEqual([{ op: "move", dx: 120, dy: 0 }]);
    expect(only("nudge store up")).toEqual([{ op: "move", target: "store", dx: 0, dy: -40 }]);
  });

  it("parses the whole app-control vocabulary", () => {
    expect(only("undo")).toEqual([{ op: "history", action: "undo" }]);
    expect(only("start over")).toEqual([{ op: "canvas", action: "clear" }]);
    expect(only("show me the sample")).toEqual([{ op: "canvas", action: "sample" }]);
    expect(only("export svg")).toEqual([{ op: "export", format: "svg" }]);
    expect(only("dark mode")).toEqual([{ op: "theme", theme: "dark" }]);
    expect(only("zoom out")).toEqual([{ op: "zoom", dir: "out" }]);
    expect(only("no arrows")).toEqual([{ op: "arrows", on: false }]);
    expect(only("write mode")).toEqual([{ op: "mode", mode: "write" }]);
    expect(only("tidy up")).toEqual([{ op: "tidy" }]);
    expect(only("what can i say")).toEqual([{ op: "help" }]);
  });

  it("strips wake words and politeness", () => {
    expect(only("hey plexus, please add a box")).toEqual([{ op: "add", shape: "rect" }]);
  });

  it("reports clauses it cannot parse instead of guessing", () => {
    const { ops, unparsed } = parseUtterance("add a box. summon a unicorn");
    expect(ops).toHaveLength(1);
    expect(unparsed).toEqual(["summon a unicorn"]);
  });
});

// ---------------------------------------------------------------------------
// op validation (the boundary the LLM tier crosses)
// ---------------------------------------------------------------------------

describe("validateOp", () => {
  it("accepts well-formed ops and rejects malformed ones", () => {
    expect(validateOp({ op: "add", shape: "rect", label: "  hi  " })).toEqual({
      op: "add",
      shape: "rect",
      label: "hi",
    });
    expect(validateOp({ op: "add", shape: "octagon" })).toBeNull();
    expect(validateOp({ op: "connect", chain: ["a"] })).toBeNull();
    expect(validateOp({ op: "fill", color: "red" })).toBeNull();
    expect(validateOp({ op: "fill", color: "#ABC" })).toEqual({ op: "fill", color: "#ABC" });
    expect(validateOp({ op: "drop database" })).toBeNull();
    expect(validateOp("undo")).toBeNull();
  });

  it("clamps hostile input rather than failing the whole batch", () => {
    const ops = validateOps([
      { op: "move", dx: 1e9, dy: -1e9 },
      { op: "nonsense" },
      { op: "rename", label: "x".repeat(500) },
    ]);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ op: "move", dx: 4000, dy: -4000 });
    expect(ops[1]).toMatchObject({ op: "rename" });
    expect((ops[1] as { label: string }).label).toHaveLength(120);
  });
});

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

describe("layout", () => {
  it("never places a new node on top of an existing one", () => {
    const doc: Doc = { nodes: [node({ id: "a", x: 100, y: 100 })], edges: [] };
    const spot = placeNode(doc, { w: 160, h: 100 });
    const overlaps =
      spot.x < 260 + PLACE_GAP / 2 && spot.x + 160 > 100 && spot.y < 200 && spot.y + 100 > 100;
    expect(overlaps).toBe(false);
  });

  it("tucks a node to the right of its anchor", () => {
    const anchor = node({ id: "a", x: 100, y: 100 });
    const spot = placeNode({ nodes: [anchor], edges: [] }, { w: 160, h: 100 }, anchor);
    expect(spot.x).toBeGreaterThan(anchor.x + anchor.w);
  });

  it("lays a chain out left to right", () => {
    const doc: Doc = {
      nodes: [
        node({ id: "c", x: 900, y: 700 }),
        node({ id: "a", x: 0, y: 0 }),
        node({ id: "b", x: 40, y: 20 }),
      ],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "c")],
    };
    const out = tidyLayout(doc);
    const at = (id: string) => out.nodes.find((n) => n.id === id)!;
    expect(at("a").x).toBeLessThan(at("b").x);
    expect(at("b").x).toBeLessThan(at("c").x);
    expect(out.edges).toBe(doc.edges);
  });

  it("terminates on a cycle and parks orphans below", () => {
    const doc: Doc = {
      nodes: [node({ id: "a" }), node({ id: "b" }), node({ id: "lonely", y: -500 })],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "a")],
    };
    const out = tidyLayout(doc);
    const lonely = out.nodes.find((n) => n.id === "lonely")!;
    const linked = out.nodes.filter((n) => n.id !== "lonely");
    expect(lonely.y).toBeGreaterThan(Math.max(...linked.map((n) => n.y)));
  });
});

// ---------------------------------------------------------------------------
// planner
// ---------------------------------------------------------------------------

describe("planner", () => {
  it("builds a whole graph from one utterance", () => {
    const plan = say("connect intake to review to ship");
    expect(plan.doc.nodes.map((n) => n.label)).toEqual(["Intake", "Review", "Ship"]);
    expect(plan.doc.edges).toHaveLength(2);
    expect(plan.added).toHaveLength(3);
    expect(plan.problems).toEqual([]);
  });

  it("reuses existing nodes instead of duplicating them", () => {
    const doc: Doc = { nodes: [node({ id: "a", label: "Intake" })], edges: [] };
    const plan = say("connect intake to review", doc);
    expect(plan.doc.nodes).toHaveLength(2);
    expect(plan.doc.edges[0]!.from).toEqual({ node: "a" });
  });

  it("resolves a spoken name by prefix, by shape, and by the selection", () => {
    const doc: Doc = {
      nodes: [
        node({ id: "a", label: "Signal input" }),
        node({ id: "b", type: "cylinder", label: "Archive" }),
      ],
      edges: [],
    };
    expect(say("rename signal to Source", doc).doc.nodes[0]!.label).toBe("Source");
    expect(say("delete the database", doc).doc.nodes.map((n) => n.id)).toEqual(["a"]);
    const selected = say("make it blue", doc, { selection: { kind: "node", id: "b" } });
    expect(selected.doc.nodes[1]!.fill).toBe("#eef2fb");
  });

  it("does not silently act when a name matches nothing", () => {
    const doc: Doc = { nodes: [node({ id: "a", label: "Intake" })], edges: [] };
    const plan = say("delete the quarterly forecast", doc);
    expect(plan.doc).toBe(doc);
    expect(plan.problems).toHaveLength(1);
  });

  it("labels the selected edge when nothing else is named", () => {
    const doc: Doc = {
      nodes: [node({ id: "a" }), node({ id: "b" })],
      edges: [edge("e1", "a", "b")],
    };
    const plan = say("label yes", doc, { selection: { kind: "edge", id: "e1" } });
    expect(plan.doc.edges[0]!.label).toBe("Yes");
  });

  it('clears a fill when asked for "auto"', () => {
    const doc: Doc = { nodes: [node({ id: "a", label: "Box", fill: "#eef2fb" })], edges: [] };
    const plan = say("fill box white", doc);
    expect(plan.doc.nodes[0]!).not.toHaveProperty("fill");
  });

  it("keeps whole-document commands out of the same breath as edits", () => {
    const plan = planOps(
      [{ op: "add", shape: "rect" }, { op: "history", action: "undo" }],
      ctx({ nodes: [], edges: [] }),
    );
    expect(plan.effects).toEqual([]);
    expect(plan.problems).toHaveLength(1);
    expect(plan.doc.nodes).toHaveLength(1);
  });

  it("routes app control to effects and leaves the document alone", () => {
    const doc: Doc = { nodes: [node({ id: "a" })], edges: [] };
    const plan = say("dark mode", doc);
    expect(plan.doc).toBe(doc);
    expect(plan.effects).toEqual([{ kind: "theme", theme: "dark" }]);
  });

  it("does not mutate the document it was given", () => {
    const doc: Doc = { nodes: [node({ id: "a", label: "Intake" })], edges: [] };
    const snapshot = JSON.stringify(doc);
    say("connect intake to review to ship. make it green", doc);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// one utterance = one undo entry
// ---------------------------------------------------------------------------

describe("replace-doc", () => {
  it("collapses a multi-node utterance into a single undo step", () => {
    const plan = say("connect intake to review to ship");
    const next = docReducer(initialDocState, {
      type: "replace-doc",
      doc: plan.doc,
      selection: plan.selection,
    });
    expect(next.doc.nodes).toHaveLength(3);
    expect(docReducer(next, { type: "undo" }).doc.nodes).toHaveLength(0);
  });

  it("does not burn an undo slot when the document is unchanged", () => {
    const state = docReducer(initialDocState, { type: "add-node", node: node({ id: "a" }) });
    const same = docReducer(state, {
      type: "replace-doc",
      doc: state.doc,
      selection: { kind: "node", id: "a" },
    });
    expect(same.past).toBe(state.past);
    expect(same.selection).toEqual({ kind: "node", id: "a" });
  });
});
