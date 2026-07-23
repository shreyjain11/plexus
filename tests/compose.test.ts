import { describe, expect, it } from "vitest";
import {
  WRITE,
  blendEm,
  distToBox,
  fontSizeFor,
  isFarFrom,
  isSpaceGap,
  textNodeWidth,
} from "../src/recognition/compose";

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe("write composition helpers", () => {
  it("blends the em estimate toward new glyph heights", () => {
    expect(blendEm(null, 80)).toBe(80);
    const blended = blendEm(80, 40);
    expect(blended).toBeLessThan(80);
    expect(blended).toBeGreaterThan(40);
    // Degenerate flat glyphs (a dash) never drag em toward zero.
    expect(blendEm(null, 0)).toBeGreaterThanOrEqual(8);
  });

  it("reads a wide horizontal gap as a space, a tight one as same-word", () => {
    const em = 80;
    const prev = box(100, 100, 60, em);
    expect(isSpaceGap(prev, box(175, 100, 60, em), em)).toBe(false); // 15px gap
    expect(isSpaceGap(prev, box(220, 100, 60, em), em)).toBe(true); // 60px > 0.5em
  });

  it("measures distance to a box as zero inside and euclidean outside", () => {
    const b = box(0, 0, 100, 50);
    expect(distToBox({ x: 50, y: 25 }, b)).toBe(0);
    expect(distToBox({ x: 130, y: 25 }, b)).toBe(30);
    expect(distToBox({ x: 103, y: 54 }, b)).toBeCloseTo(5, 5);
  });

  it("treats ink far from the composition as a new text node", () => {
    const b = box(0, 0, 200, 80);
    const em = 60;
    expect(isFarFrom(b, { x: 210, y: 40 }, em)).toBe(false); // 10px away
    expect(isFarFrom(b, { x: 200 + WRITE.FAR_RATIO * em + 5, y: 40 }, em)).toBe(true);
  });

  it("clamps font size to the configured range", () => {
    expect(fontSizeFor(6)).toBe(WRITE.FONT_MIN);
    expect(fontSizeFor(500)).toBe(WRITE.FONT_MAX);
    expect(fontSizeFor(40)).toBe(36);
  });

  it("grows text node width with label length and never collapses", () => {
    expect(textNodeWidth("", 15)).toBe(60);
    const short = textNodeWidth("HI", 24);
    const long = textNodeWidth("HELLO WORLD", 24);
    expect(long).toBeGreaterThan(short);
  });
});
