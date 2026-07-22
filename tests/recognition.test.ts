import { describe, expect, it } from "vitest";
import { classifyStroke } from "../src/recognition/classify";
import { borderPoint, routeEdge, snapEnd } from "../src/recognition/snap";
import { isNodeRef, type DiagramNode, type Point, type Stroke } from "../src/types";

/** Deterministic PRNG so jittered strokes are stable across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jitter(points: Stroke, amount: number, seed: number): Stroke {
  const rnd = mulberry32(seed);
  return points.map((p) => ({
    x: p.x + (rnd() * 2 - 1) * amount,
    y: p.y + (rnd() * 2 - 1) * amount,
  }));
}

/** Trace a rectangle's perimeter, leaving a small hand-like closure gap. */
function rectStroke(x: number, y: number, w: number, h: number, n = 120): Stroke {
  const per = 2 * (w + h);
  const pts: Stroke = [];
  for (let i = 0; i < n; i++) {
    const s = (i / n) * per * 0.985; // stop just short of closing perfectly
    let d = s;
    if (d < w) pts.push({ x: x + d, y });
    else if ((d -= w) < h) pts.push({ x: x + w, y: y + d });
    else if ((d -= h) < w) pts.push({ x: x + w - d, y: y + h });
    else pts.push({ x, y: y + h - (d - w) });
  }
  return pts;
}

function ellipseStroke(cx: number, cy: number, rx: number, ry: number, n = 100): Stroke {
  const pts: Stroke = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 * 0.98;
    pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return pts;
}

function lineStroke(a: Point, b: Point, bow = 0, n = 40): Stroke {
  const pts: Stroke = [];
  const nx = -(b.y - a.y);
  const ny = b.x - a.x;
  const len = Math.hypot(nx, ny) || 1;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const arc = Math.sin(t * Math.PI) * bow;
    pts.push({
      x: a.x + (b.x - a.x) * t + (nx / len) * arc,
      y: a.y + (b.y - a.y) * t + (ny / len) * arc,
    });
  }
  return pts;
}

describe("classifyStroke — nodes", () => {
  it("recognizes a jittered rectangle as a rect node with its bbox", () => {
    const rec = classifyStroke(jitter(rectStroke(100, 100, 200, 120), 2.5, 7));
    expect(rec.kind).toBe("node");
    if (rec.kind !== "node") return;
    expect(rec.type).toBe("rect");
    expect(rec.x).toBeCloseTo(100, -1);
    expect(rec.y).toBeCloseTo(100, -1);
    expect(rec.w).toBeCloseTo(200, -1.5);
    expect(rec.h).toBeCloseTo(120, -1.5);
  });

  it("recognizes a jittered square as a rect (radius CV alone would call it round)", () => {
    const rec = classifyStroke(jitter(rectStroke(50, 50, 140, 140), 2.5, 11));
    expect(rec).toMatchObject({ kind: "node", type: "rect" });
  });

  it("recognizes a jittered circle as an ellipse", () => {
    const rec = classifyStroke(jitter(ellipseStroke(300, 300, 80, 80), 2.5, 13));
    expect(rec).toMatchObject({ kind: "node", type: "ellipse" });
  });

  it("recognizes an elongated ellipse (CV above the strict cut) as an ellipse", () => {
    const rec = classifyStroke(jitter(ellipseStroke(300, 300, 120, 55), 2, 17));
    expect(rec).toMatchObject({ kind: "node", type: "ellipse" });
  });

  it("clamps tiny closed sketches to the minimum node size, keeping the center", () => {
    const rec = classifyStroke(ellipseStroke(400, 250, 14, 12, 40));
    expect(rec.kind).toBe("node");
    if (rec.kind !== "node") return;
    expect(rec.w).toBe(72);
    expect(rec.h).toBe(48);
    expect(rec.x + rec.w / 2).toBeCloseTo(400, 0);
    expect(rec.y + rec.h / 2).toBeCloseTo(250, 0);
  });
});

describe("classifyStroke — connectors and rejects", () => {
  it("recognizes a slightly bowed line as an edge with the stroke's endpoints", () => {
    const rec = classifyStroke(jitter(lineStroke({ x: 100, y: 100 }, { x: 340, y: 180 }, 14), 1.5, 19));
    expect(rec.kind).toBe("edge");
    if (rec.kind !== "edge") return;
    expect(rec.from.x).toBeCloseTo(100, -1);
    expect(rec.to.x).toBeCloseTo(340, -1);
  });

  it("still accepts a gentle arc (straightness just above the cut)", () => {
    const pts: Stroke = [];
    for (let i = 0; i <= 50; i++) {
      const a = Math.PI - (i / 50) * Math.PI; // semicircle: straightness ≈ 0.64
      pts.push({ x: 200 + 100 * Math.cos(a), y: 200 - 60 * Math.sin(a) });
    }
    expect(classifyStroke(pts).kind).toBe("edge");
  });

  it("rejects a curly scribble as too-curly", () => {
    const pts: Stroke = [];
    for (let i = 0; i <= 120; i++) {
      const t = i / 120;
      pts.push({ x: 100 + t * 90 + 30 * Math.sin(t * 24), y: 200 + 40 * Math.sin(t * 17 + 1) });
    }
    expect(classifyStroke(pts)).toMatchObject({ kind: "reject", reason: "too-curly" });
  });

  it("rejects taps and tiny flicks as too-small", () => {
    expect(classifyStroke([{ x: 5, y: 5 }])).toMatchObject({ kind: "reject", reason: "too-small" });
    expect(classifyStroke(lineStroke({ x: 0, y: 0 }, { x: 6, y: 4 }, 0, 10))).toMatchObject({
      kind: "reject",
      reason: "too-small",
    });
  });
});

const rectNode: DiagramNode = { id: "a", type: "rect", x: 100, y: 100, w: 120, h: 80, label: "" };
const ellipseNode: DiagramNode = { id: "b", type: "ellipse", x: 400, y: 100, w: 120, h: 80, label: "" };
const nodesById = new Map([
  ["a", rectNode],
  ["b", ellipseNode],
]);

describe("snapping and routing", () => {
  it("snaps endpoints inside a node (or within the pad) to that node", () => {
    expect(snapEnd({ x: 160, y: 140 }, [rectNode])).toEqual({ node: "a" });
    expect(snapEnd({ x: 230, y: 140 }, [rectNode])).toEqual({ node: "a" }); // 10px outside
    expect(snapEnd({ x: 300, y: 140 }, [rectNode])).toEqual({ x: 300, y: 140 });
  });

  it("routes node-to-node edges center-to-center, clipped to both borders", () => {
    const routed = routeEdge({ id: "e", from: { node: "a" }, to: { node: "b" }, arrow: true }, nodesById);
    expect(routed).not.toBeNull();
    // Centers are (160,140) and (460,140): a horizontal line, so it should
    // leave the rect at its right edge and enter the ellipse at its left tip.
    expect(routed!.y1).toBeCloseTo(140, 5);
    expect(routed!.y2).toBeCloseTo(140, 5);
    expect(routed!.x1).toBeCloseTo(220, 5);
    expect(routed!.x2).toBeCloseTo(400, 5);
  });

  it("clips against the ellipse boundary parametrically", () => {
    const p = borderPoint(ellipseNode, { x: 460, y: 1000 }); // straight down from center
    expect(p.x).toBeCloseTo(460, 5);
    expect(p.y).toBeCloseTo(180, 5);
    const q = borderPoint(ellipseNode, { x: 520, y: 200 }); // diagonal: on the ellipse
    const dx = (q.x - 460) / 60;
    const dy = (q.y - 140) / 40;
    expect(dx * dx + dy * dy).toBeCloseTo(1, 5);
  });

  it("drops degenerate self-edges and dangling references", () => {
    expect(routeEdge({ id: "e", from: { node: "a" }, to: { node: "a" }, arrow: true }, nodesById)).toBeNull();
    expect(routeEdge({ id: "e", from: { node: "zz" }, to: { node: "a" }, arrow: true }, nodesById)).toBeNull();
  });

  it("keeps free endpoints exactly where the stroke ended", () => {
    const routed = routeEdge(
      { id: "e", from: { x: 20, y: 30 }, to: { node: "a" }, arrow: true },
      nodesById,
    );
    expect(routed).toMatchObject({ x1: 20, y1: 30 });
    const end = snapEnd({ x: 20, y: 30 }, [rectNode]);
    expect(isNodeRef(end)).toBe(false);
  });
});
