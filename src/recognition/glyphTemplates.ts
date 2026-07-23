/**
 * Handwriting templates for the $P glyph recognizer.
 *
 * Each glyph is defined as 1–3 polyline strokes inside a 1×1 box (x right,
 * y DOWN, like screen coordinates). Strokes are sparse control polylines —
 * the recognizer resamples them into a uniform point cloud, so only the
 * overall geometry matters, not point density. Because $P matching is
 * stroke-order and stroke-direction invariant, one template covers every
 * reasonable writing order of, say, an H.
 *
 * Some characters get a second variant where people genuinely write two
 * distinct forms (1 with/without the flag, 7 with/without the crossbar, …).
 * `0` deliberately has no template: an oval is an O, and forcing a guess
 * between them would just make both feel unreliable (README documents this).
 */

/** One drawn stroke: a polyline of [x, y] pairs in the unit box. */
export type TemplateStroke = ReadonlyArray<readonly [number, number]>;

export interface GlyphDef {
  char: string;
  strokes: readonly TemplateStroke[];
}

const seg = (...pts: ReadonlyArray<readonly [number, number]>): TemplateStroke => pts;

/**
 * Sampled elliptical arc. Angles in degrees with 0° = +x and 90° = +y
 * (i.e. *down*, since templates use screen orientation).
 */
function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  a0: number,
  a1: number,
  n = 14,
): TemplateStroke {
  const pts: Array<readonly [number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/** Concatenate stroke fragments into one continuous stroke. */
const join = (...parts: TemplateStroke[]): TemplateStroke => parts.flat();

export const GLYPH_TEMPLATES: readonly GlyphDef[] = [
  // ---------- letters ----------
  { char: "A", strokes: [seg([0, 1], [0.5, 0]), seg([0.5, 0], [1, 1]), seg([0.18, 0.62], [0.82, 0.62])] },
  {
    char: "B",
    strokes: [seg([0, 0], [0, 1]), arc(0, 0.25, 0.5, 0.25, -90, 90), arc(0, 0.75, 0.56, 0.25, -90, 90)],
  },
  { char: "C", strokes: [arc(0.5, 0.5, 0.5, 0.5, -55, -305)] },
  { char: "D", strokes: [seg([0, 0], [0, 1]), arc(0, 0.5, 0.85, 0.5, -90, 90)] },
  {
    char: "E",
    strokes: [seg([1, 0], [0, 0], [0, 1], [1, 1]), seg([0, 0.5], [0.8, 0.5])],
  },
  { char: "F", strokes: [seg([1, 0], [0, 0], [0, 1]), seg([0, 0.5], [0.75, 0.5])] },
  {
    char: "G",
    strokes: [join(arc(0.5, 0.5, 0.5, 0.5, -55, -305), seg([0.97, 0.75], [0.97, 0.58], [0.55, 0.58]))],
  },
  { char: "H", strokes: [seg([0, 0], [0, 1]), seg([1, 0], [1, 1]), seg([0, 0.5], [1, 0.5])] },
  { char: "I", strokes: [seg([0.5, 0], [0.5, 1])] },
  {
    char: "I",
    strokes: [seg([0.2, 0], [0.8, 0]), seg([0.5, 0], [0.5, 1]), seg([0.2, 1], [0.8, 1])],
  },
  { char: "J", strokes: [join(seg([0.7, 0], [0.7, 0.7]), arc(0.35, 0.7, 0.35, 0.3, 0, 180))] },
  { char: "K", strokes: [seg([0, 0], [0, 1]), seg([1, 0], [0.05, 0.52], [1, 1])] },
  { char: "L", strokes: [seg([0, 0], [0, 1], [0.9, 1])] },
  { char: "M", strokes: [seg([0, 1], [0, 0], [0.5, 0.65], [1, 0], [1, 1])] },
  { char: "N", strokes: [seg([0, 1], [0, 0], [1, 1], [1, 0])] },
  { char: "O", strokes: [arc(0.5, 0.5, 0.5, 0.5, -90, 270, 24)] },
  { char: "P", strokes: [seg([0, 0], [0, 1]), arc(0, 0.27, 0.55, 0.27, -90, 90)] },
  { char: "Q", strokes: [arc(0.5, 0.5, 0.5, 0.5, -90, 270, 24), seg([0.62, 0.62], [1, 1])] },
  {
    char: "R",
    strokes: [seg([0, 0], [0, 1]), arc(0, 0.25, 0.53, 0.25, -90, 90), seg([0.12, 0.5], [1, 1])],
  },
  {
    char: "S",
    strokes: [
      seg(
        [0.9, 0.14],
        [0.62, 0.01],
        [0.28, 0.02],
        [0.07, 0.18],
        [0.12, 0.38],
        [0.42, 0.5],
        [0.72, 0.6],
        [0.92, 0.76],
        [0.82, 0.94],
        [0.48, 1],
        [0.13, 0.94],
        [0.02, 0.8],
      ),
    ],
  },
  { char: "T", strokes: [seg([0, 0], [1, 0]), seg([0.5, 0], [0.5, 1])] },
  {
    char: "U",
    strokes: [join(seg([0, 0], [0, 0.6]), arc(0.5, 0.6, 0.5, 0.4, 180, 0), seg([1, 0.6], [1, 0]))],
  },
  { char: "V", strokes: [seg([0, 0], [0.5, 1], [1, 0])] },
  { char: "W", strokes: [seg([0, 0], [0.25, 1], [0.5, 0.4], [0.75, 1], [1, 0])] },
  { char: "X", strokes: [seg([0, 0], [1, 1]), seg([1, 0], [0, 1])] },
  { char: "Y", strokes: [seg([0, 0], [0.5, 0.45], [0.5, 1]), seg([1, 0], [0.5, 0.45])] },
  { char: "Z", strokes: [seg([0, 0], [1, 0], [0, 1], [1, 1])] },

  // ---------- digits (0 intentionally absent — an oval reads as O) ----------
  { char: "1", strokes: [seg([0.28, 0.2], [0.55, 0], [0.55, 1])] },
  {
    char: "2",
    strokes: [
      seg(
        [0.06, 0.24],
        [0.18, 0.05],
        [0.5, 0],
        [0.82, 0.06],
        [0.93, 0.26],
        [0.84, 0.47],
        [0.5, 0.68],
        [0.14, 0.9],
        [0, 1],
        [1, 1],
      ),
    ],
  },
  {
    char: "3",
    strokes: [
      seg(
        [0.1, 0.1],
        [0.45, 0],
        [0.85, 0.09],
        [0.9, 0.3],
        [0.55, 0.48],
        [0.9, 0.62],
        [0.9, 0.85],
        [0.5, 1],
        [0.1, 0.9],
      ),
    ],
  },
  { char: "4", strokes: [seg([0.68, 0], [0.02, 0.62], [1, 0.62]), seg([0.68, 0], [0.68, 1])] },
  {
    char: "5",
    strokes: [
      seg([0.9, 0], [0.14, 0], [0.11, 0.42]),
      seg([0.11, 0.42], [0.5, 0.35], [0.86, 0.46], [0.9, 0.7], [0.6, 0.96], [0.2, 0.98], [0.02, 0.84]),
    ],
  },
  {
    char: "5",
    strokes: [
      seg(
        [0.9, 0],
        [0.14, 0],
        [0.11, 0.42],
        [0.5, 0.35],
        [0.86, 0.46],
        [0.9, 0.7],
        [0.6, 0.96],
        [0.2, 0.98],
        [0.02, 0.84],
      ),
    ],
  },
  {
    char: "6",
    strokes: [
      join(
        seg([0.76, 0], [0.4, 0.2], [0.16, 0.5], [0.1, 0.72]),
        arc(0.48, 0.74, 0.38, 0.26, 160, 520, 18),
      ),
    ],
  },
  { char: "7", strokes: [seg([0, 0], [1, 0], [0.4, 1])] },
  { char: "7", strokes: [seg([0, 0], [1, 0], [0.4, 1]), seg([0.22, 0.5], [0.78, 0.5])] },
  {
    char: "8",
    strokes: [arc(0.5, 0.26, 0.32, 0.26, -90, 270, 18), arc(0.5, 0.74, 0.38, 0.26, -90, 270, 18)],
  },
  {
    char: "9",
    strokes: [join(arc(0.45, 0.28, 0.34, 0.28, 0, 360, 18), seg([0.79, 0.28], [0.7, 1]))],
  },
];
