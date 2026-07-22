import type { Point, Stroke } from "../types";

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function bbox(points: Stroke): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function diagonal(b: Bounds): number {
  return Math.hypot(b.w, b.h);
}

export function pathLength(points: Stroke): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += dist(points[i - 1]!, points[i]!);
  }
  return len;
}

export function centroid(points: Stroke): Point {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

/**
 * Resample a polyline to `n` points spaced uniformly by arc length, so pen
 * speed does not bias shape statistics. When `closeLoop` is set the segment
 * from the last point back to the first is included and the result is a ring
 * of `n` points with no duplicated closure point.
 */
export function resample(points: Stroke, n: number, closeLoop = false): Stroke {
  const src = closeLoop ? [...points, points[0]!] : points;
  const total = pathLength(src);
  if (total === 0 || src.length < 2) {
    return Array.from({ length: n }, () => ({ ...src[0]! }));
  }
  const step = total / (closeLoop ? n : n - 1);
  const out: Stroke = [{ ...src[0]! }];
  let acc = 0;
  let prev = src[0]!;
  for (let i = 1; i < src.length && out.length < n; ) {
    const cur = src[i]!;
    const seg = dist(prev, cur);
    if (acc + seg >= step && seg > 0) {
      const t = (step - acc) / seg;
      const q = { x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) };
      out.push(q);
      prev = q;
      acc = 0;
    } else {
      acc += seg;
      prev = cur;
      i++;
    }
  }
  while (out.length < n) out.push({ ...src[src.length - 1]! });
  return out;
}
