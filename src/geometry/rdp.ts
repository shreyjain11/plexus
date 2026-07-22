import type { Point, Stroke } from "../types";

function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

/**
 * Ramer–Douglas–Peucker simplification returning INDICES into `points`, so
 * callers can relate simplified vertices back to positions along the stroke.
 */
export function rdpIndices(points: Stroke, epsilon: number): number[] {
  const n = points.length;
  if (n < 3) return points.map((_, i) => i);
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpendicularDistance(points[i]!, points[lo]!, points[hi]!);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > epsilon) {
      keep[index] = true;
      stack.push([lo, index], [index, hi]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Ramer–Douglas–Peucker polyline simplification. */
export function rdp(points: Stroke, epsilon: number): Stroke {
  return rdpIndices(points, epsilon).map((i) => points[i]!);
}
