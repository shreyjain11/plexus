import type { Point } from "../types";
import type { Bounds } from "../geometry/vec";

/**
 * Pure decision helpers for Write-mode composition — when a buffered glyph
 * commits, when a gap is a space, when the writer has moved on to a new
 * text node. Kept free of React and timers so the thresholds are unit-testable.
 */
export const WRITE = {
  /**
   * Pen-up pause that commits the buffered strokes as one glyph. Grouping by
   * geometry alone is genuinely ambiguous (an H's second vertical looks
   * exactly like the next letter's first stroke until the crossbar arrives),
   * so the pause is the sole intra-glyph grouping signal — the classic
   * Graffiti-style resolution.
   */
  COMMIT_MS: 650,
  /** Idle time after the last committed glyph that ends the composition. */
  IDLE_MS: 2500,
  /** Horizontal gap (in ems) between glyphs that reads as a space. */
  SPACE_RATIO: 0.5,
  /** Distance (in ems) from the composition at which new ink starts a new text node. */
  FAR_RATIO: 3,
  /** Blend factor for the running em estimate (height of a typical glyph). */
  EM_BLEND: 0.65,
  FONT_MIN: 13,
  FONT_MAX: 64,
} as const;

/** Update the running em (glyph height) estimate with a newly committed glyph. */
export function blendEm(prev: number | null, glyphH: number): number {
  const h = Math.max(8, glyphH);
  return prev === null ? h : prev * WRITE.EM_BLEND + h * (1 - WRITE.EM_BLEND);
}

/** Does the horizontal gap between two committed glyph boxes read as a space? */
export function isSpaceGap(prev: Bounds, next: Bounds, em: number): boolean {
  return next.x - (prev.x + prev.w) > WRITE.SPACE_RATIO * em;
}

/** Distance from a point to an axis-aligned box (0 inside). */
export function distToBox(p: Point, b: Bounds): number {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

/** Has the writer moved far enough away that this ink belongs to a new text node? */
export function isFarFrom(compBox: Bounds, p: Point, em: number): boolean {
  return distToBox(p, compBox) > WRITE.FAR_RATIO * em;
}

/** Font size for a composition written at glyph height `em`. */
export function fontSizeFor(em: number): number {
  return Math.round(Math.min(WRITE.FONT_MAX, Math.max(WRITE.FONT_MIN, em * 0.9)));
}

/** Width for a text node holding `label` at `fontSize` (mono-ish advance). */
export function textNodeWidth(label: string, fontSize: number): number {
  return Math.max(60, Math.round(label.length * fontSize * 0.62) + 18);
}
