import type { Point, Stroke } from "../types";
import { bbox, dist, pathLength, resample } from "../geometry/vec";
import { GLYPH_TEMPLATES } from "./glyphTemplates";

/**
 * $P point-cloud glyph recognizer (Vatavu, Anthony & Wildemuth, ICMI 2012).
 *
 * A glyph — one or more strokes — is normalized into a fixed-size point
 * cloud and matched against the character templates with a greedy cloud
 * distance. Point clouds carry no stroke order or direction, which is the
 * whole reason $P fits handwriting: an H is an H whether the crossbar came
 * first or last, drawn left-to-right or right-to-left.
 *
 * Everything here is pure and geometry-only: no ML, no network, no state.
 */

export const GLYPH = {
  /** Points per normalized cloud. */
  SAMPLES: 32,
  /**
   * Reject matches whose weighted mean cloud distance (in normalized unit
   * space, aspect penalty included) exceeds this — better to say
   * "NOT A LETTER" than to force a scribble into the nearest character.
   * Tuned against the vitest suite: genuine glyphs score ≤ 0.085 at normal
   * jitter and ≤ 0.103 even at heavy air-drawn jitter (5px + 9° rotation),
   * while the adversarial scribble's best forced match sits at 0.124.
   */
  REJECT_ABOVE: 0.115,
  /** Weight of the aspect-ratio mismatch penalty added to the cloud distance. */
  ASPECT_WEIGHT: 0.1,
  /** Ignore glyphs smaller than this (scene units) — accidental taps. */
  MIN_SIZE: 12,
} as const;

export interface GlyphMatch {
  char: string;
  /** Weighted mean cloud distance incl. aspect penalty — lower is better. */
  score: number;
}

/** Signed aspect in [-1, 1]: positive = wide, negative = tall, 0 = square. */
function aspectOf(w: number, h: number): number {
  const m = Math.max(w, h);
  return m === 0 ? 0 : (w - h) / m;
}

/**
 * Turn raw strokes into a normalized N-point cloud: points are distributed
 * across strokes proportionally to stroke length, then uniformly scaled by
 * the longest bbox side (NOT per-axis — squashing a thin `I` or `1` into a
 * square would destroy exactly the feature that identifies it) and centered
 * on the centroid.
 */
export function normalizeGlyph(strokes: readonly Stroke[]): { cloud: Point[]; aspect: number } | null {
  const kept = strokes.filter((s) => s.length > 0);
  if (kept.length === 0) return null;

  const lengths = kept.map((s) => pathLength(s));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  // Allocate samples per stroke by length share (each stroke keeps ≥ 2 so a
  // short crossbar never vanishes), fixing rounding drift on the longest.
  const alloc = lengths.map((len) => Math.max(2, Math.round((GLYPH.SAMPLES * len) / total)));
  let drift = alloc.reduce((a, b) => a + b, 0) - GLYPH.SAMPLES;
  while (drift !== 0) {
    const i = alloc.indexOf(Math.max(...alloc));
    const step = drift > 0 ? -1 : 1;
    if (alloc[i]! + step < 2) break;
    alloc[i]! += step;
    drift += step > 0 ? 1 : -1;
  }

  const cloud: Point[] = [];
  kept.forEach((s, i) => cloud.push(...resample(s, alloc[i]!, false)));

  const b = bbox(cloud);
  const size = Math.max(b.w, b.h);
  if (size === 0) return null;

  const scaled = cloud.map((p) => ({ x: (p.x - b.x) / size, y: (p.y - b.y) / size }));
  const cx = scaled.reduce((a, p) => a + p.x, 0) / scaled.length;
  const cy = scaled.reduce((a, p) => a + p.y, 0) / scaled.length;
  return {
    cloud: scaled.map((p) => ({ x: p.x - cx, y: p.y - cy })),
    aspect: aspectOf(b.w, b.h),
  };
}

/** One-directional greedy cloud distance, weighted so early (confident) pairings count more. */
function cloudDistance(a: readonly Point[], b: readonly Point[], start: number): number {
  const n = a.length;
  const matched = new Array<boolean>(n).fill(false);
  let sum = 0;
  let i = start;
  do {
    let min = Infinity;
    let index = -1;
    for (let j = 0; j < n; j++) {
      if (matched[j]) continue;
      const d = dist(a[i]!, b[j]!);
      if (d < min) {
        min = d;
        index = j;
      }
    }
    matched[index] = true;
    const weight = 1 - ((i - start + n) % n) / n;
    sum += weight * min;
    i = (i + 1) % n;
  } while (i !== start);
  return sum;
}

/** Symmetric greedy match over a handful of start alignments (canonical $P). */
function greedyCloudMatch(a: readonly Point[], b: readonly Point[]): number {
  const n = a.length;
  const step = Math.max(1, Math.floor(Math.sqrt(n)));
  let min = Infinity;
  for (let i = 0; i < n; i += step) {
    min = Math.min(min, cloudDistance(a, b, i), cloudDistance(b, a, i));
  }
  // Normalize by the weight total so the score is a mean distance in unit
  // space, independent of SAMPLES.
  const weightTotal = n - (n - 1) / 2;
  return min / weightTotal;
}

interface CompiledTemplate {
  char: string;
  cloud: Point[];
  aspect: number;
}

let compiled: CompiledTemplate[] | null = null;

function templates(): CompiledTemplate[] {
  if (!compiled) {
    compiled = [];
    for (const def of GLYPH_TEMPLATES) {
      const norm = normalizeGlyph(def.strokes.map((s) => s.map(([x, y]) => ({ x, y }))));
      if (norm) compiled.push({ char: def.char, cloud: norm.cloud, aspect: norm.aspect });
    }
  }
  return compiled;
}

/**
 * Recognize a multi-stroke glyph. Returns the best character and its score,
 * or null when the ink is too small or matches nothing convincingly.
 */
export function recognizeGlyph(strokes: readonly Stroke[]): GlyphMatch | null {
  const all = strokes.flat();
  if (all.length === 0) return null;
  const b = bbox(all);
  if (Math.max(b.w, b.h) < GLYPH.MIN_SIZE) return null;

  const norm = normalizeGlyph(strokes);
  if (!norm) return null;

  let best: GlyphMatch | null = null;
  for (const t of templates()) {
    const d = greedyCloudMatch(norm.cloud, t.cloud) + GLYPH.ASPECT_WEIGHT * Math.abs(norm.aspect - t.aspect);
    if (!best || d < best.score) best = { char: t.char, score: d };
  }
  return best && best.score <= GLYPH.REJECT_ABOVE ? best : null;
}
