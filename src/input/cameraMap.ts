/**
 * Mapping from camera-normalized hand coordinates to the scene.
 *
 * Only the central region of the camera frame maps to the canvas: reaching
 * the true edges of a webcam's field of view requires big arm movements and
 * is where MediaPipe tracking is least reliable, so a margin trades a little
 * range for a lot of precision.
 */

/** Fraction of the frame trimmed from EACH side before mapping. */
export const CAMERA_MARGIN = 0.14;

/** Map a [0,1] camera coordinate through the margin window, clamped. */
export function mapWithMargin(n: number, margin: number = CAMERA_MARGIN): number {
  const t = (n - margin) / (1 - 2 * margin);
  return Math.min(1, Math.max(0, t));
}

export interface ViewWindow {
  /** Scene coordinate of the viewport's top-left corner. */
  x: number;
  y: number;
  /** Viewport size in scene units (css size ÷ zoom). */
  w: number;
  h: number;
}

/**
 * Camera-normalized (already mirrored) → scene coordinates for the current
 * viewport, so hand input tracks correctly under zoom and pan.
 */
export function cameraToScene(
  nx: number,
  ny: number,
  view: ViewWindow,
): { x: number; y: number } {
  return {
    x: view.x + mapWithMargin(nx) * view.w,
    y: view.y + mapWithMargin(ny) * view.h,
  };
}
