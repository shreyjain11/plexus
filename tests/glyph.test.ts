import { describe, expect, it } from "vitest";
import { GLYPH, normalizeGlyph, recognizeGlyph } from "../src/recognition/glyph";
import { GLYPH_TEMPLATES } from "../src/recognition/glyphTemplates";
import { resample } from "../src/geometry/vec";
import type { Point, Stroke } from "../src/types";

/** Deterministic PRNG so jittered glyphs are stable across runs. */
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

/**
 * Turn a template into "handwriting": scale to `size` px at an offset,
 * densify each stroke, add jitter, and rotate a few degrees — the same
 * imperfections a mouse or air-drawn glyph carries.
 */
function handwrite(
  strokes: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  opts: { size?: number; jitter?: number; rotateDeg?: number; seed?: number } = {},
): Stroke[] {
  const { size = 120, jitter = 3, rotateDeg = 0, seed = 1 } = opts;
  const rnd = mulberry32(seed);
  const rad = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = 200 + size / 2;
  const cy = 300 + size / 2;
  return strokes.map((s) => {
    const scaled: Point[] = s.map(([x, y]) => ({ x: 200 + x * size, y: 300 + y * size }));
    const dense = resample(scaled, Math.max(8, Math.min(32, Math.round(scaled.length * 6))), false);
    return dense.map((p) => {
      const jx = p.x + (rnd() * 2 - 1) * jitter;
      const jy = p.y + (rnd() * 2 - 1) * jitter;
      return {
        x: cx + (jx - cx) * cos - (jy - cy) * sin,
        y: cy + (jx - cx) * sin + (jy - cy) * cos,
      };
    });
  });
}

function circleStrokes(r = 60, n = 48): Stroke[] {
  const pts: Stroke = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2 * 0.97;
    pts.push({ x: 300 + r * Math.cos(a), y: 300 + r * Math.sin(a) });
  }
  return [pts];
}

describe("recognizeGlyph — every template self-recognizes as handwriting", () => {
  GLYPH_TEMPLATES.forEach((def, i) => {
    it(`recognizes a jittered, slightly rotated "${def.char}" (template #${i})`, () => {
      const rec = recognizeGlyph(handwrite(def.strokes, { jitter: 3, rotateDeg: 6, seed: i * 7 + 1 }));
      expect(rec?.char).toBe(def.char);
    });
    it(`recognizes "${def.char}" rotated the other way (template #${i})`, () => {
      const rec = recognizeGlyph(handwrite(def.strokes, { jitter: 2.5, rotateDeg: -7, seed: i * 13 + 5 }));
      expect(rec?.char).toBe(def.char);
    });
  });
});

describe("recognizeGlyph — adversarial input", () => {
  it("reads a plain drawn circle as O", () => {
    expect(recognizeGlyph(circleStrokes())?.char).toBe("O");
  });

  it("rejects a random scribble instead of forcing a character", () => {
    const rnd = mulberry32(99);
    const pts: Stroke = [];
    for (let i = 0; i <= 90; i++) {
      const t = i / 90;
      pts.push({
        x: 200 + t * 110 + 45 * Math.sin(t * 29 + rnd()),
        y: 300 + 55 * Math.sin(t * 23 + 2) + 25 * Math.sin(t * 41),
      });
    }
    expect(recognizeGlyph([pts])).toBeNull();
  });

  it("rejects accidental taps (below MIN_SIZE)", () => {
    expect(
      recognizeGlyph([
        [
          { x: 100, y: 100 },
          { x: 104, y: 103 },
        ],
      ]),
    ).toBeNull();
    expect(recognizeGlyph([[]])).toBeNull();
  });

  it("keeps easily confused pairs apart", () => {
    // H must not collapse into I/1 (two verticals + crossbar vs one vertical).
    const h = GLYPH_TEMPLATES.find((d) => d.char === "H")!;
    expect(recognizeGlyph(handwrite(h.strokes, { seed: 41 }))?.char).toBe("H");
    // V (sharp) vs U (round bottom).
    const v = GLYPH_TEMPLATES.find((d) => d.char === "V")!;
    const u = GLYPH_TEMPLATES.find((d) => d.char === "U")!;
    expect(recognizeGlyph(handwrite(v.strokes, { seed: 43 }))?.char).toBe("V");
    expect(recognizeGlyph(handwrite(u.strokes, { seed: 47 }))?.char).toBe("U");
    // E vs F (bottom bar present/absent).
    const e = GLYPH_TEMPLATES.find((d) => d.char === "E")!;
    const f = GLYPH_TEMPLATES.find((d) => d.char === "F")!;
    expect(recognizeGlyph(handwrite(e.strokes, { seed: 53 }))?.char).toBe("E");
    expect(recognizeGlyph(handwrite(f.strokes, { seed: 59 }))?.char).toBe("F");
  });
});

describe("normalizeGlyph", () => {
  it("produces exactly SAMPLES points, centered and unit-scaled", () => {
    const norm = normalizeGlyph(handwrite(GLYPH_TEMPLATES[0]!.strokes));
    expect(norm).not.toBeNull();
    expect(norm!.cloud.length).toBe(GLYPH.SAMPLES);
    const cx = norm!.cloud.reduce((a, p) => a + p.x, 0) / GLYPH.SAMPLES;
    const cy = norm!.cloud.reduce((a, p) => a + p.y, 0) / GLYPH.SAMPLES;
    expect(cx).toBeCloseTo(0, 6);
    expect(cy).toBeCloseTo(0, 6);
    for (const p of norm!.cloud) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
    }
  });

  it("keeps a thin vertical stroke thin (uniform scale, not per-axis)", () => {
    const norm = normalizeGlyph([
      [
        { x: 100, y: 100 },
        { x: 101, y: 220 },
      ],
    ]);
    expect(norm).not.toBeNull();
    const xs = norm!.cloud.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.05);
    expect(norm!.aspect).toBeLessThan(-0.9); // strongly tall
  });

  it("returns null for empty or zero-length ink", () => {
    expect(normalizeGlyph([])).toBeNull();
    expect(normalizeGlyph([[{ x: 5, y: 5 }]])).toBeNull();
  });
});
