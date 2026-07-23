import type { NodeType, Point } from "../types";

/**
 * Canonical vertex geometry for the polygonal node shapes, shared by the
 * canvas renderer, the SVG exporter, and edge-border clipping so all three
 * always agree on where a shape's outline actually is.
 */

/** How far (as a fraction of width) a parallelogram's top edge is shifted right. */
export const PARALLELOGRAM_SKEW = 0.22;
/** Hexagon side vertices sit at this fraction of the width from each end. */
export const HEXAGON_INSET = 0.25;
/** Cylinder cap half-height as a fraction of node height (clamped). */
export function cylinderCapRy(w: number, h: number): number {
  return Math.min(h * 0.16, w * 0.35);
}

/** Vertices (clockwise) for polygonal shapes; null for non-polygons. */
export function shapeVertices(
  type: NodeType,
  x: number,
  y: number,
  w: number,
  h: number,
): Point[] | null {
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (type) {
    case "diamond":
      return [
        { x: cx, y },
        { x: x + w, y: cy },
        { x: cx, y: y + h },
        { x, y: cy },
      ];
    case "triangle":
      return [
        { x: cx, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
    case "hexagon": {
      const inset = w * HEXAGON_INSET;
      return [
        { x: x + inset, y },
        { x: x + w - inset, y },
        { x: x + w, y: cy },
        { x: x + w - inset, y: y + h },
        { x: x + inset, y: y + h },
        { x, y: cy },
      ];
    }
    case "parallelogram": {
      const skew = w * PARALLELOGRAM_SKEW;
      return [
        { x: x + skew, y },
        { x: x + w, y },
        { x: x + w - skew, y: y + h },
        { x, y: y + h },
      ];
    }
    default:
      return null;
  }
}

/** SVG points attribute for a polygonal shape. */
export function shapePoints(type: NodeType, x: number, y: number, w: number, h: number): string {
  const verts = shapeVertices(type, x, y, w, h);
  return verts ? verts.map((p) => `${p.x},${p.y}`).join(" ") : "";
}

/**
 * SVG path for a cylinder silhouette: straight sides, bulged bottom, and a
 * top arc. The visible "lid" ellipse is drawn separately on top of it.
 */
export function cylinderPath(x: number, y: number, w: number, h: number): string {
  const rx = w / 2;
  const ry = cylinderCapRy(w, h);
  const top = y + ry;
  const bottom = y + h - ry;
  return [
    `M ${x} ${top}`,
    `L ${x} ${bottom}`,
    `A ${rx} ${ry} 0 0 0 ${x + w} ${bottom}`,
    `L ${x + w} ${top}`,
    `A ${rx} ${ry} 0 0 0 ${x} ${top}`,
    "Z",
  ].join(" ");
}
