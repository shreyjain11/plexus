import type { DiagramEdge, DiagramNode, EdgeEnd, Point } from "../types";
import { isNodeRef } from "../types";

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
 * Where the ray from a node's center toward `target` crosses the node border.
 * Rectangles clip against the AABB; ellipses against the parametric boundary.
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
  } else {
    const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
    const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
    t = Math.min(tx, ty);
  }
  return { x: c.x + t * dx, y: c.y + t * dy };
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
