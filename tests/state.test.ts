import { describe, expect, it } from "vitest";
import { docReducer, initialDocState, samplePathway, type DocState } from "../src/state/doc";
import { docToJson, loadLocal, parseDocJson, validateDoc } from "../src/state/persist";
import { mapWithMargin } from "../src/input/cameraMap";
import type { DiagramNode } from "../src/types";

const node = (over: Partial<DiagramNode> = {}): DiagramNode => ({
  id: "n1",
  type: "rect",
  x: 10,
  y: 20,
  w: 100,
  h: 80,
  label: "",
  ...over,
});

function addNode(state: DocState, n: DiagramNode, select = false): DocState {
  return docReducer(state, { type: "add-node", node: n, select });
}

describe("docReducer — v2 actions", () => {
  it("undo then redo round-trips, and a new mutation clears redo", () => {
    let s = addNode(initialDocState, node());
    expect(s.doc.nodes).toHaveLength(1);

    s = docReducer(s, { type: "undo" });
    expect(s.doc.nodes).toHaveLength(0);
    expect(s.future).toHaveLength(1);

    s = docReducer(s, { type: "redo" });
    expect(s.doc.nodes).toHaveLength(1);
    expect(s.future).toHaveLength(0);

    s = docReducer(s, { type: "undo" });
    s = addNode(s, node({ id: "n2" })); // new mutation while redo is pending
    expect(s.future).toHaveLength(0);
    expect(docReducer(s, { type: "redo" })).toBe(s); // nothing to redo
  });

  it("resize-node clamps to the per-type minimum size", () => {
    let s = addNode(initialDocState, node());
    s = docReducer(s, { type: "resize-node", id: "n1", x: 10, y: 20, w: 5, h: 5 });
    const n = s.doc.nodes[0]!;
    expect(n.w).toBe(40);
    expect(n.h).toBe(32);
  });

  it("set-label / set-edge-label / set-fill no-ops add no undo entry", () => {
    let s = addNode(initialDocState, node({ label: "A" }));
    const depth = s.past.length;
    expect(docReducer(s, { type: "set-label", id: "n1", label: "A" })).toBe(s);
    expect(docReducer(s, { type: "set-fill", id: "n1", fill: "" })).toBe(s); // already auto
    s = docReducer(s, { type: "set-fill", id: "n1", fill: "#eef2fb" });
    expect(s.doc.nodes[0]!.fill).toBe("#eef2fb");
    expect(s.past.length).toBe(depth + 1);
    // Clearing back to auto drops the property entirely.
    s = docReducer(s, { type: "set-fill", id: "n1", fill: "" });
    expect("fill" in s.doc.nodes[0]!).toBe(false);
  });

  it("edge labels set and clear (clearing drops the property)", () => {
    let s = addNode(initialDocState, node());
    s = addNode(s, node({ id: "n2", x: 300 }));
    s = docReducer(s, {
      type: "add-edge",
      edge: { id: "e1", from: { node: "n1" }, to: { node: "n2" }, arrow: true },
    });
    s = docReducer(s, { type: "set-edge-label", id: "e1", label: "yes" });
    expect(s.doc.edges[0]!.label).toBe("yes");
    s = docReducer(s, { type: "set-edge-label", id: "e1", label: "" });
    expect("label" in s.doc.edges[0]!).toBe(false);
  });

  it("delete-node removes the node and its incident edges", () => {
    let s = addNode(initialDocState, node());
    s = addNode(s, node({ id: "n2", x: 300 }));
    s = docReducer(s, {
      type: "add-edge",
      edge: { id: "e1", from: { node: "n1" }, to: { node: "n2" }, arrow: true },
    });
    s = docReducer(s, { type: "delete-node", id: "n1" });
    expect(s.doc.nodes.map((n) => n.id)).toEqual(["n2"]);
    expect(s.doc.edges).toHaveLength(0);
  });

  it("load-doc replaces the doc and is undoable", () => {
    let s = addNode(initialDocState, node());
    s = docReducer(s, { type: "load-doc", doc: samplePathway() });
    expect(s.doc.nodes.length).toBeGreaterThan(3);
    s = docReducer(s, { type: "undo" });
    expect(s.doc.nodes.map((n) => n.id)).toEqual(["n1"]);
  });
});

describe("persistence", () => {
  it("round-trips a doc through JSON", () => {
    const doc = samplePathway();
    const parsed = parseDocJson(docToJson(doc));
    expect(parsed).toEqual(doc);
  });

  it("rejects corrupt or foreign payloads", () => {
    expect(parseDocJson("not json at all")).toBeNull();
    expect(parseDocJson('{"v":2}')).toBeNull();
    expect(parseDocJson('{"v":2,"doc":{"nodes":[{"id":1}],"edges":[]}}')).toBeNull();
    expect(validateDoc({ nodes: "nope", edges: [] })).toBeNull();
    expect(
      validateDoc({
        nodes: [node(), node()], // duplicate ids
        edges: [],
      }),
    ).toBeNull();
    expect(
      validateDoc({ nodes: [{ ...node(), type: "blob" }], edges: [] }),
    ).toBeNull();
    expect(
      validateDoc({ nodes: [{ ...node(), fontSize: "big" }], edges: [] }),
    ).toBeNull();
  });

  it("accepts every v3 node type and the optional fontSize", () => {
    const types = ["rect", "ellipse", "diamond", "triangle", "hexagon", "parallelogram", "cylinder", "text"];
    const doc = validateDoc({
      nodes: types.map((type, i) => ({ ...node({ id: `n${i}` }), type })),
      edges: [],
    });
    expect(doc).not.toBeNull();
    expect(doc!.nodes).toHaveLength(types.length);
    expect(validateDoc({ nodes: [{ ...node(), fontSize: 32 }], edges: [] })).not.toBeNull();
  });

  it("loadLocal falls back to the v2 autosave key (one-way migration)", () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    (globalThis as Record<string, unknown>).localStorage = fake;
    try {
      const doc = samplePathway();
      store.set("plexus.doc.v2", JSON.stringify({ v: 2, doc }));
      expect(loadLocal()).toEqual(doc);
      // A v3 payload wins over the legacy key.
      const other = { nodes: [node({ id: "solo" })], edges: [] };
      store.set("plexus.doc.v3", JSON.stringify({ v: 3, doc: other }));
      expect(loadLocal()?.nodes[0]?.id).toBe("solo");
    } finally {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it("drops edges that reference missing nodes instead of rejecting the doc", () => {
    const doc = validateDoc({
      nodes: [node()],
      edges: [
        { id: "e1", from: { node: "n1" }, to: { node: "ghost" }, arrow: true },
        { id: "e2", from: { node: "n1" }, to: { x: 5, y: 5 }, arrow: false },
      ],
    });
    expect(doc).not.toBeNull();
    expect(doc!.edges.map((e) => e.id)).toEqual(["e2"]);
  });
});

describe("camera margin mapping", () => {
  it("maps the central window to the full range and clamps outside it", () => {
    expect(mapWithMargin(0.5)).toBeCloseTo(0.5, 6);
    expect(mapWithMargin(0.14)).toBeCloseTo(0, 6);
    expect(mapWithMargin(0.86)).toBeCloseTo(1, 6);
    expect(mapWithMargin(0.02)).toBe(0);
    expect(mapWithMargin(0.98)).toBe(1);
  });
});
