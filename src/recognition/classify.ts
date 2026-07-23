import type { NodeType, Point, Stroke } from "../types";
import { bbox, centroid, diagonal, dist, pathLength, resample } from "../geometry/vec";
import { rdpIndices } from "../geometry/rdp";

export type Recognition =
  | { kind: "node"; type: NodeType; x: number; y: number; w: number; h: number }
  | { kind: "edge"; from: Point; to: Point }
  /** "self-edge" is issued downstream when both snapped ends hit one node. */
  | { kind: "reject"; reason: "too-small" | "too-curly" | "self-edge" };

export const RECOG = {
  /** Strokes below these are treated as accidental taps/noise. */
  MIN_POINTS: 8,
  MIN_PATH: 24,
  /** closed ⇔ endpoint gap < 0.28·diagonal AND path length comfortably exceeds it. */
  CLOSED_GAP_RATIO: 0.28,
  CLOSED_LEN_RATIO: 1.15,
  /** RDP epsilon as a fraction of the bbox diagonal. */
  RDP_EPS_RATIO: 0.045,
  /** A "real corner" turns between these interior angles (degrees). */
  CORNER_MIN_DEG: 40,
  CORNER_MAX_DEG: 145,
  /** Radius coefficient-of-variation thresholds for roundness. */
  ELLIPSE_CV: 0.19,
  ELLIPSE_CV_LOOSE: 0.3,
  /** Open strokes straighter than this become connectors; curlier are rejected. */
  STRAIGHTNESS_MIN: 0.62,
  /** Minimum emitted node size so tiny sketches stay usable. */
  MIN_NODE_W: 72,
  MIN_NODE_H: 48,
  /** Closed strokes are resampled to this ring size for shape statistics. */
  RING_SAMPLES: 64,
  /** Half-window (in ring samples) for the corner "straw" test. */
  STRAW_WINDOW: 4,
  /** A straw must dip below this fraction of the straight-straw baseline to
   * indicate a corner. */
  STRAW_DIP: 0.93,
  /**
   * Baseline percentile for the straw comparison. The median fails on corner-
   * rich shapes: a hexagon's six corners each depress straws across a ±W
   * window, touching 6·2W = 48 of 64 ring samples, so the median is itself a
   * corner-depressed straw and no dip clears the threshold. The 80th
   * percentile still lands on a mid-side (straight) straw for every shape we
   * classify, while a circle's uniform straws keep it dip-free.
   */
  STRAW_BASELINE_PCT: 0.8,
  /** Mean corner "midpointness" below this reads as a diamond (see isDiamond). */
  DIAMOND_MIDPOINTNESS: 0.4,
  /** A diamond also fills only ~half its bbox. Requiring this keeps a jittered
   * hexagon (area ≈ 0.75) whose side vertices ALSO sit at edge midpoints from
   * being mistaken for a diamond when noise hides a corner or two. */
  DIAMOND_AREA_MAX: 0.62,
  /** Ring-area / bbox-area below this (with 3 corners) reads as a triangle. */
  TRIANGLE_AREA_MAX: 0.72,
  /** Ring-area / bbox-area window (with 4–6 corners) that reads as a hexagon —
   * a sloppy rectangle that sheds an extra RDP corner still fills ~0.9+, and
   * anything emptier than ~0.62 is diamond/triangle territory. */
  HEXAGON_AREA_MIN: 0.62,
  HEXAGON_AREA_MAX: 0.88,
} as const;

const ringIndex = (i: number, n: number): number => ((i % n) + n) % n;

/** Direction change (degrees, 0 = straight ahead) at b for chords a→b→c. */
function turningDeg(a: Point, b: Point, c: Point): number {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const vx = c.x - b.x;
  const vy = c.y - b.y;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu === 0 || lv === 0) return 0;
  const cos = Math.min(1, Math.max(-1, (ux * vx + uy * vy) / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Count real corners on a closed ring of uniformly resampled points.
 *
 * Candidates come from RDP (epsilon = 4.5% of the bbox diagonal) run over the
 * ring split at its farthest-apart pair, per the classic closed-shape trick.
 * A candidate only counts as a *real* corner when
 *   (a) the direction change there is between CORNER_MIN_DEG and
 *       CORNER_MAX_DEG (sharper is a hairpin, shallower is drift), and
 *   (b) the local "straw" — the chord across a fixed small window, after
 *       ShortStraw (Wolin et al. 2008) — dips below STRAW_DIP · median.
 * The straw dip is what separates genuine corners from the gentle, evenly
 * distributed turning of a circle: RDP vertices on a smooth ellipse turn
 * ~50–60° (inside the angle window!) but their straws sit at the median,
 * while a drawn rectangle's corners concentrate all turning in one spot.
 */
function countRingCorners(ring: Stroke, epsilon: number): number[] {
  const n = ring.length;
  const W = RECOG.STRAW_WINDOW;

  // Straws: chord length across the +-W window at each ring sample.
  const straws = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    straws[i] = dist(ring[ringIndex(i - W, n)]!, ring[ringIndex(i + W, n)]!);
  }
  const sorted = [...straws].sort((a, b) => a - b);
  const baseline = sorted[Math.min(n - 1, Math.floor(n * RECOG.STRAW_BASELINE_PCT))]!;
  const dipThreshold = RECOG.STRAW_DIP * baseline;

  // Split the ring at the farthest-apart pair so RDP sees two open chains.
  let bi = 0;
  let bj = 0;
  let far = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = dist(ring[i]!, ring[j]!);
      if (d > far) {
        far = d;
        bi = i;
        bj = j;
      }
    }
  }
  const chainA: number[] = [];
  for (let i = bi; ; i = ringIndex(i + 1, n)) {
    chainA.push(i);
    if (i === bj) break;
  }
  const chainB: number[] = [];
  for (let i = bj; ; i = ringIndex(i + 1, n)) {
    chainB.push(i);
    if (i === bi) break;
  }

  const simplify = (chain: number[]): number[] =>
    rdpIndices(chain.map((i) => ring[i]!), epsilon).map((k) => chain[k]!);

  // Simplified ring: both chains share their endpoints; drop each chain's last.
  const simp = [...simplify(chainA).slice(0, -1), ...simplify(chainB).slice(0, -1)];
  const m = simp.length;
  if (m < 3) return [];

  const corners: number[] = [];
  let lastPos = -Infinity;
  let firstPos = Infinity;
  for (let k = 0; k < m; k++) {
    const iPrev = simp[ringIndex(k - 1, m)]!;
    const iCur = simp[k]!;
    const iNext = simp[ringIndex(k + 1, m)]!;
    const turn = turningDeg(ring[iPrev]!, ring[iCur]!, ring[iNext]!);
    if (turn < RECOG.CORNER_MIN_DEG || turn > RECOG.CORNER_MAX_DEG) continue;
    if (straws[iCur]! >= dipThreshold) continue;
    // Merge vertices RDP may have doubled up on a single physical corner,
    // measured in traversal order (pos increases monotonically from bi).
    const pos = ringIndex(iCur - bi, n);
    if (pos - lastPos < 2 * W) continue;
    if (firstPos !== Infinity && firstPos + n - pos < 2 * W) continue;
    corners.push(iCur);
    lastPos = pos;
    if (firstPos === Infinity) firstPos = pos;
  }
  return corners;
}

/**
 * Mean corner "midpointness": how close corners sit to the bbox edge
 * midpoints (0) versus the bbox corners (1). Diamond vertices lie near the
 * edge midpoints (normalized coordinates (±1,0)/(0,±1) from the center),
 * rectangle corners near (±1,±1) — the mean of min(|nx|,|ny|) separates them.
 */
function cornerMidpointness(ring: Stroke, cornerIdx: number[]): number {
  const b = bbox(ring);
  if (b.w === 0 || b.h === 0 || cornerIdx.length === 0) return 1;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  let sum = 0;
  for (const i of cornerIdx) {
    const p = ring[i]!;
    const nx = Math.abs((p.x - cx) / (b.w / 2));
    const ny = Math.abs((p.y - cy) / (b.h / 2));
    sum += Math.min(nx, ny);
  }
  return sum / cornerIdx.length;
}

function isDiamond(ring: Stroke, cornerIdx: number[]): boolean {
  if (cornerIdx.length < 3 || cornerIdx.length > 5) return false;
  return (
    cornerMidpointness(ring, cornerIdx) < RECOG.DIAMOND_MIDPOINTNESS &&
    ringAreaRatio(ring) < RECOG.DIAMOND_AREA_MAX
  );
}

/**
 * |shoelace area| of the ring divided by its bbox area — a strong second
 * feature where corner counts are ambiguous: a rectangle fills ~0.95 of its
 * bbox, a hexagon ~0.75, a triangle or diamond ~0.5.
 */
function ringAreaRatio(ring: Stroke): number {
  const b = bbox(ring);
  if (b.w === 0 || b.h === 0) return 1;
  let area2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    area2 += p.x * q.y - q.x * p.y;
  }
  return Math.abs(area2 / 2) / (b.w * b.h);
}

/** std/mean of distances from the ring centroid — 0 for a perfect circle. */
function radiusCv(ring: Stroke): number {
  const c = centroid(ring);
  const radii = ring.map((p) => dist(p, c));
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  if (mean === 0) return 0;
  const variance = radii.reduce((a, r) => a + (r - mean) * (r - mean), 0) / radii.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Classify a finished stroke.
 *
 * Closed strokes become nodes (rectangle or ellipse); open, reasonably
 * straight strokes become connectors; everything else is rejected with a
 * reason the UI can surface as a hint.
 */
export function classifyStroke(stroke: Stroke): Recognition {
  if (stroke.length < RECOG.MIN_POINTS) return { kind: "reject", reason: "too-small" };

  const bounds = bbox(stroke);
  const diag = diagonal(bounds);
  const len = pathLength(stroke);
  if (len < RECOG.MIN_PATH || diag === 0) return { kind: "reject", reason: "too-small" };

  const first = stroke[0]!;
  const last = stroke[stroke.length - 1]!;
  const gap = dist(first, last);
  const closed = gap < RECOG.CLOSED_GAP_RATIO * diag && len > RECOG.CLOSED_LEN_RATIO * diag;

  if (closed) {
    const ring = resample(stroke, RECOG.RING_SAMPLES, true);
    const cornerIdx = countRingCorners(ring, RECOG.RDP_EPS_RATIO * diag);
    const corners = cornerIdx.length;
    const cv = radiusCv(ring);
    const isEllipse =
      corners < 3 && (cv < RECOG.ELLIPSE_CV || (corners <= 2 && cv < RECOG.ELLIPSE_CV_LOOSE));

    const areaRatio = ringAreaRatio(ring);
    let type: NodeType;
    if (isEllipse) type = "ellipse";
    else if (isDiamond(ring, cornerIdx)) type = "diamond";
    else if (corners === 3 && areaRatio < RECOG.TRIANGLE_AREA_MAX) type = "triangle";
    else if (
      corners >= 4 &&
      corners <= 6 &&
      areaRatio >= RECOG.HEXAGON_AREA_MIN &&
      areaRatio < RECOG.HEXAGON_AREA_MAX
    )
      type = "hexagon";
    else type = "rect";

    // Enforce a minimum size, growing outward from the sketch's center.
    const w = Math.max(bounds.w, RECOG.MIN_NODE_W);
    const h = Math.max(bounds.h, RECOG.MIN_NODE_H);
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    return { kind: "node", type, x: cx - w / 2, y: cy - h / 2, w, h };
  }

  const straightness = gap / len;
  if (straightness < RECOG.STRAIGHTNESS_MIN) return { kind: "reject", reason: "too-curly" };
  return { kind: "edge", from: { ...first }, to: { ...last } };
}
