import type { DiagramEdge, DiagramNode, EdgeEnd, Point } from "../types";
import { isNodeRef } from "../types";
import { shapeVertices } from "../geometry/shapes";

/** How far outside a node's bbox a connector endpoint may land and still attach. */
export const SNAP_PAD = 18;

export function nodeCenter(n: DiagramNode): Point {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

/**
 * Snap a connector endpoint to a node if it lands inside the node's bbox
 * inflated by SNAP_PAD. With overlapping candidates, the nearest center wins.
 */
export function snapEnd(p: Point, nodes: readonly DiagramNode[]): EdgeEnd {
  let best: DiagramNode | null = null;
  let bestDist = Infinity;
  for (const n of nodes) {
    const inside =
      p.x >= n.x - SNAP_PAD &&
      p.x <= n.x + n.w + SNAP_PAD &&
      p.y >= n.y - SNAP_PAD &&
      p.y <= n.y + n.h + SNAP_PAD;
    if (!inside) continue;
    const c = nodeCenter(n);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return best ? { node: best.id } : { ...p };
}

/**
 * Where the ray c + t·d (t > 0) first crosses the boundary of a convex
 * polygon. Returns the smallest positive t, or null when the ray misses
 * (degenerate polygon / center outside).
 */
export function polygonRayT(verts: readonly Point[], c: Point, d: Point): number | null {
  let best: number | null = null;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = d.x * ey - d.y * ex;
    if (Math.abs(denom) < 1e-9) continue; // ray parallel to this edge
    const t = ((a.x - c.x) * ey - (a.y - c.y) * ex) / denom;
    const s = denom !== 0 ? ((a.x - c.x) * d.y - (a.y - c.y) * d.x) / denom : -1;
    if (t > 1e-9 && s >= -1e-9 && s <= 1 + 1e-9 && (best === null || t < best)) best = t;
  }
  return best;
}

/**
 * Where the ray from a node's center toward `target` crosses the node border.
 * Rectangles, text boxes, and cylinders clip against the AABB (a cylinder's
 * bulges are cosmetic), ellipses against the parametric boundary, diamonds
 * against the rhombus (a scaled L1 ball), and the other polygonal shapes
 * against their actual edges.
 */
export function borderPoint(node: DiagramNode, target: Point): Point {
  const c = nodeCenter(node);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = node.w / 2;
  const hh = node.h / 2;
  let t: number;
  if (node.type === "ellipse") {
    t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  } else if (node.type === "diamond") {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else if (node.type === "triangle" || node.type === "hexagon" || node.type === "parallelogram") {
    const verts = shapeVertices(node.type, node.x, node.y, node.w, node.h)!;
    const hit = polygonRayT(verts, c, { x: dx, y: dy });
    t = hit ?? Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  } else {
    const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
    const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
    t = Math.min(tx, ty);
  }
  return { x: c.x + t * dx, y: c.y + t * dy };
}

export const ALIGN_TOLERANCE = 6;

export interface AlignedPosition {
  x: number;
  y: number;
  /** Scene-x of a matched vertical center line, if the node snapped to one. */
  guideX: number | null;
  /** Scene-y of a matched horizontal center line, if the node snapped to one. */
  guideY: number | null;
}

/**
 * Center-alignment snapping for drags: if the moving node's center comes
 * within ALIGN_TOLERANCE of another node's center on either axis, snap to it
 * and report the guide line so the canvas can draw it.
 */
export function snapToAlignment(
  nodes: readonly DiagramNode[],
  movingId: string,
  x: number,
  y: number,
  w: number,
  h: number,
): AlignedPosition {
  let cx = x + w / 2;
  let cy = y + h / 2;
  let guideX: number | null = null;
  let guideY: number | null = null;
  let bestDx = ALIGN_TOLERANCE;
  let bestDy = ALIGN_TOLERANCE;
  for (const n of nodes) {
    if (n.id === movingId) continue;
    const ocx = n.x + n.w / 2;
    const ocy = n.y + n.h / 2;
    const dx = Math.abs(ocx - cx);
    const dy = Math.abs(ocy - cy);
    if (dx < bestDx) {
      bestDx = dx;
      guideX = ocx;
    }
    if (dy < bestDy) {
      bestDy = dy;
      guideY = ocy;
    }
  }
  if (guideX !== null) cx = guideX;
  if (guideY !== null) cy = guideY;
  return { x: cx - w / 2, y: cy - h / 2, guideX, guideY };
}

export interface RoutedEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function resolveAnchor(end: EdgeEnd, nodesById: ReadonlyMap<string, DiagramNode>): Point | null {
  if (!isNodeRef(end)) return end;
  const n = nodesById.get(end.node);
  return n ? nodeCenter(n) : null;
}

/**
 * Compute the drawn segment for an edge. Node-attached ends route
 * center-to-center, then clip to the node border so arrowheads land on the
 * outline. Recomputed every render, so dragging a node re-routes live.
 */
export function routeEdge(
  edge: DiagramEdge,
  nodesById: ReadonlyMap<string, DiagramNode>,
): RoutedEdge | null {
  const fromAnchor = resolveAnchor(edge.from, nodesById);
  const toAnchor = resolveAnchor(edge.to, nodesById);
  if (!fromAnchor || !toAnchor) return null;
  if (isNodeRef(edge.from) && isNodeRef(edge.to) && edge.from.node === edge.to.node) return null;

  let p1 = fromAnchor;
  let p2 = toAnchor;
  if (isNodeRef(edge.from)) {
    p1 = borderPoint(nodesById.get(edge.from.node)!, toAnchor);
  }
  if (isNodeRef(edge.to)) {
    p2 = borderPoint(nodesById.get(edge.to.node)!, fromAnchor);
  }
  if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 1) return null;
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}
