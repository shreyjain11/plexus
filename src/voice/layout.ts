import type { DiagramNode, Doc } from "../types";
import { isNodeRef } from "../types";

/**
 * Placement and auto-layout for commands that create or rearrange nodes.
 *
 * Spoken commands carry no coordinates, so the planner has to decide where a
 * new node goes. Both functions here are pure `Doc`-in/geometry-out, which
 * keeps them unit-testable and keeps the planner free of DOM measurements.
 */

/** Breathing room between a new node and everything already on the canvas. */
export const PLACE_GAP = 56;
/** Vertical gap between stacked nodes in a tidied column. */
export const ROW_GAP = 48;
/** Horizontal gap between tidied layers. */
export const COL_GAP = 96;
/** Where the first node of an empty canvas lands, and the tidy origin. */
export const ORIGIN = { x: 96, y: 140 } as const;
/** New nodes wrap to a fresh row past this width. */
const ROW_WIDTH = 1080;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function hits(a: Box, b: Box, pad: number): boolean {
  return (
    a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y
  );
}

function isFree(box: Box, nodes: readonly DiagramNode[], pad: number): boolean {
  return !nodes.some((n) => hits(box, n, pad));
}

/**
 * Choose a top-left corner for a new node of `size`.
 *
 * With an anchor, the node is tucked beside it (right first — diagrams here
 * read left to right). Without one, the canvas is filled as a wrapping row.
 * Either way the result never overlaps an existing node.
 */
export function placeNode(
  doc: Doc,
  size: { w: number; h: number },
  anchor?: DiagramNode | null,
): { x: number; y: number } {
  const nodes = doc.nodes;
  const pad = PLACE_GAP / 2;

  const candidates: Array<{ x: number; y: number }> = [];
  if (anchor) {
    candidates.push(
      { x: anchor.x + anchor.w + PLACE_GAP, y: anchor.y + (anchor.h - size.h) / 2 },
      { x: anchor.x + (anchor.w - size.w) / 2, y: anchor.y + anchor.h + PLACE_GAP },
      { x: anchor.x - size.w - PLACE_GAP, y: anchor.y + (anchor.h - size.h) / 2 },
      { x: anchor.x + (anchor.w - size.w) / 2, y: anchor.y - size.h - PLACE_GAP },
    );
  } else if (nodes.length === 0) {
    return { ...ORIGIN };
  } else {
    let right = -Infinity;
    let rightNode: DiagramNode | null = null;
    let bottom = -Infinity;
    let left = Infinity;
    for (const n of nodes) {
      if (n.x + n.w > right) {
        right = n.x + n.w;
        rightNode = n;
      }
      bottom = Math.max(bottom, n.y + n.h);
      left = Math.min(left, n.x);
    }
    const nextX = right + PLACE_GAP;
    if (rightNode && nextX + size.w <= left + ROW_WIDTH) {
      candidates.push({ x: nextX, y: rightNode.y });
    }
    candidates.push({ x: left, y: bottom + PLACE_GAP });
  }

  for (const c of candidates) {
    if (isFree({ ...c, ...size }, nodes, pad)) return { x: Math.round(c.x), y: Math.round(c.y) };
  }

  // Nothing obvious was free — walk down, then across, from the first guess.
  const start = candidates[0] ?? { ...ORIGIN };
  const step = size.h + PLACE_GAP;
  for (let col = 0; col < 8; col++) {
    for (let row = 0; row < 24; row++) {
      const box = {
        x: start.x + col * (size.w + PLACE_GAP),
        y: start.y + row * step,
        w: size.w,
        h: size.h,
      };
      if (isFree(box, nodes, pad)) return { x: Math.round(box.x), y: Math.round(box.y) };
    }
  }
  return { x: Math.round(start.x), y: Math.round(start.y) };
}

/** Node-to-node links, ignoring free-floating endpoints and self-loops. */
function nodeLinks(doc: Doc): Array<[string, string]> {
  const present = new Set(doc.nodes.map((n) => n.id));
  const out: Array<[string, string]> = [];
  for (const e of doc.edges) {
    if (!isNodeRef(e.from) || !isNodeRef(e.to)) continue;
    if (e.from.node === e.to.node) continue;
    if (!present.has(e.from.node) || !present.has(e.to.node)) continue;
    out.push([e.from.node, e.to.node]);
  }
  return out;
}

/**
 * Re-position every node as left-to-right layers: each node sits one column
 * right of its furthest upstream neighbour, and columns are ordered vertically
 * by the average position of their predecessors so edges cross less.
 *
 * Cycles are tolerated — the longest-path relaxation is capped at one pass per
 * node, which leaves a cycle laid out in the order its edges were added rather
 * than looping forever. Nodes with no edges are parked in a wrapping strip
 * below the graph. Edges are untouched; they re-route from node geometry.
 */
export function tidyLayout(doc: Doc): Doc {
  const nodes = doc.nodes;
  if (nodes.length === 0) return doc;

  const at = new Map(nodes.map((n, i) => [n.id, i]));
  const links = nodeLinks(doc).map(([f, t]) => [at.get(f)!, at.get(t)!] as const);

  const connected = new Set<number>();
  for (const [f, t] of links) {
    connected.add(f);
    connected.add(t);
  }

  // Longest-path layering, relaxed at most once per node so cycles terminate.
  const layer = new Array<number>(nodes.length).fill(0);
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const [f, t] of links) {
      if (layer[t]! < layer[f]! + 1) {
        layer[t] = layer[f]! + 1;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const preds = new Map<number, number[]>();
  for (const [f, t] of links) {
    const list = preds.get(t);
    if (list) list.push(f);
    else preds.set(t, [f]);
  }

  const columns = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    if (!connected.has(i)) continue;
    const l = layer[i]!;
    const col = columns.get(l);
    if (col) col.push(i);
    else columns.set(l, [i]);
  }

  // Two barycenter passes: order each column by where its predecessors sit.
  const order = new Map<number, number>();
  const layerKeys = [...columns.keys()].sort((a, b) => a - b);
  for (const l of layerKeys) columns.get(l)!.forEach((i, k) => order.set(i, k));
  for (let pass = 0; pass < 2; pass++) {
    for (const l of layerKeys) {
      const col = columns.get(l)!;
      const key = new Map<number, number>();
      col.forEach((i, k) => {
        const ps = (preds.get(i) ?? []).map((p) => order.get(p)).filter((v): v is number => v !== undefined);
        key.set(i, ps.length > 0 ? ps.reduce((a, b) => a + b, 0) / ps.length : k);
      });
      col.sort((a, b) => key.get(a)! - key.get(b)! || order.get(a)! - order.get(b)!);
      col.forEach((i, k) => order.set(i, k));
    }
  }

  const placed = nodes.map((n) => ({ ...n }));

  let cursorX = ORIGIN.x;
  let top = Infinity;
  let bottom = -Infinity;
  for (const l of layerKeys) {
    const col = columns.get(l)!;
    const colW = Math.max(...col.map((i) => nodes[i]!.w));
    const colH = col.reduce((sum, i) => sum + nodes[i]!.h, 0) + ROW_GAP * (col.length - 1);
    let y = -colH / 2;
    for (const i of col) {
      const n = placed[i]!;
      n.x = Math.round(cursorX + (colW - n.w) / 2);
      n.y = Math.round(y);
      y += n.h + ROW_GAP;
      top = Math.min(top, n.y);
      bottom = Math.max(bottom, n.y + n.h);
    }
    cursorX += colW + COL_GAP;
  }

  // Shift the graph down so nothing sits at a negative coordinate.
  const dy = Number.isFinite(top) ? ORIGIN.y - top : 0;
  if (dy !== 0) {
    for (let i = 0; i < placed.length; i++) {
      if (connected.has(i)) placed[i]!.y += dy;
    }
  }
  let stripY = Number.isFinite(bottom) ? bottom + dy + COL_GAP : ORIGIN.y;

  // Orphans: a wrapping strip underneath, in document order.
  let stripX = ORIGIN.x;
  let stripH = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (connected.has(i)) continue;
    const n = placed[i]!;
    if (stripX > ORIGIN.x && stripX + n.w > ORIGIN.x + ROW_WIDTH) {
      stripX = ORIGIN.x;
      stripY += stripH + ROW_GAP;
      stripH = 0;
    }
    n.x = Math.round(stripX);
    n.y = Math.round(stripY);
    stripX += n.w + PLACE_GAP;
    stripH = Math.max(stripH, n.h);
  }

  const moved = placed.some((n, i) => n.x !== nodes[i]!.x || n.y !== nodes[i]!.y);
  return moved ? { nodes: placed, edges: doc.edges } : doc;
}
