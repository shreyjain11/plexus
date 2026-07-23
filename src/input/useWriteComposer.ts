import { useCallback, useEffect, useRef, useState } from "react";
import type { Point, Stroke } from "../types";
import type { DocAction } from "../state/doc";
import { bbox, type Bounds } from "../geometry/vec";
import { recognizeGlyph } from "../recognition/glyph";
import {
  WRITE,
  blendEm,
  fontSizeFor,
  isFarFrom,
  isSpaceGap,
  textNodeWidth,
} from "../recognition/compose";
import { uid } from "../state/uid";

/** The active composition: one growing text node being written into. */
interface Composition {
  nodeId: string;
  label: string;
  /** Fixed node top-left + height; only the width grows with the label. */
  x: number;
  y: number;
  h: number;
  fontSize: number;
  /** Running glyph-height estimate. */
  em: number;
  /** Bbox of the last committed glyph (space detection). */
  lastBox: Bounds;
  /** Union bbox of everything written so far (far-away detection). */
  extent: Bounds;
}

export interface WriteGuide {
  x1: number;
  x2: number;
  y: number;
}

export interface WriteComposer {
  /** Pen-up strokes of the glyph currently being buffered (render as pending ink). */
  buffer: readonly Stroke[];
  /** Dashed baseline under the active composition, if any. */
  guide: WriteGuide | null;
  composing: boolean;
  /** A finished write-mode stroke arrives here instead of the shape classifier. */
  onStroke: (stroke: Stroke) => void;
  /** Delete the last character. Returns false when there is nothing to consume. */
  backspace: () => boolean;
  /** Commit any buffered ink immediately and end the composition (Esc / mode switch). */
  flush: () => void;
}

interface Options {
  dispatch: React.Dispatch<DocAction>;
  /** Feedback per commit attempt: the recognized char (null = rejected) plus its ink. */
  onGlyph: (char: string | null, strokes: readonly Stroke[]) => void;
  /** Pulse the text node so each committed char lands with the house snap. */
  onNodePulse: (id: string) => void;
}

/**
 * Write-mode composition: buffers strokes into glyphs (committed after a
 * pen-up pause), recognizes each glyph, and grows a text node char by char.
 * Spaces come from horizontal gaps; writing far away starts a new node.
 */
export function useWriteComposer({ dispatch, onGlyph, onNodePulse }: Options): WriteComposer {
  const [buffer, setBuffer] = useState<readonly Stroke[]>([]);
  const [comp, setComp] = useState<Composition | null>(null);

  const bufferRef = useRef<Stroke[]>([]);
  const compRef = useRef<Composition | null>(null);
  compRef.current = comp;

  const commitTimer = useRef<number | null>(null);
  const idleTimer = useRef<number | null>(null);

  const clearTimer = (t: React.RefObject<number | null>) => {
    if (t.current !== null) {
      clearTimeout(t.current);
      t.current = null;
    }
  };

  useEffect(
    () => () => {
      clearTimer(commitTimer);
      clearTimer(idleTimer);
    },
    [],
  );

  const endComposition = useCallback(() => {
    clearTimer(idleTimer);
    compRef.current = null;
    setComp(null);
  }, []);

  const commitGlyph = useCallback(() => {
    clearTimer(commitTimer);
    const strokes = bufferRef.current;
    if (strokes.length === 0) return;
    bufferRef.current = [];
    setBuffer([]);

    const rec = recognizeGlyph(strokes);
    onGlyph(rec?.char ?? null, strokes);
    if (!rec) return;

    const box = bbox(strokes.flat());
    const cur = compRef.current;

    let next: Composition;
    if (!cur) {
      const em = blendEm(null, box.h);
      const fontSize = fontSizeFor(em);
      const h = Math.max(28, Math.round(em * 1.3));
      const label = rec.char;
      const nodeId = uid("n");
      next = {
        nodeId,
        label,
        x: box.x - 6,
        y: box.y + box.h / 2 - h / 2,
        h,
        fontSize,
        em,
        lastBox: box,
        extent: box,
      };
      dispatch({
        type: "add-node",
        node: {
          id: nodeId,
          type: "text",
          x: next.x,
          y: next.y,
          w: textNodeWidth(label, fontSize),
          h,
          label,
          fontSize,
        },
      });
    } else {
      const em = blendEm(cur.em, box.h);
      const space = isSpaceGap(cur.lastBox, box, em) ? " " : "";
      const label = cur.label + space + rec.char;
      next = {
        ...cur,
        label,
        em,
        lastBox: box,
        extent: {
          x: Math.min(cur.extent.x, box.x),
          y: Math.min(cur.extent.y, box.y),
          w: Math.max(cur.extent.x + cur.extent.w, box.x + box.w) - Math.min(cur.extent.x, box.x),
          h: Math.max(cur.extent.y + cur.extent.h, box.y + box.h) - Math.min(cur.extent.y, box.y),
        },
      };
      dispatch({ type: "set-label", id: cur.nodeId, label });
      // Silent geometry update (no undo snapshot — the label change carries it).
      dispatch({
        type: "resize-node",
        id: cur.nodeId,
        x: cur.x,
        y: cur.y,
        w: textNodeWidth(label, cur.fontSize),
        h: cur.h,
      });
    }

    compRef.current = next;
    setComp(next);
    onNodePulse(next.nodeId);

    clearTimer(idleTimer);
    idleTimer.current = window.setTimeout(endComposition, WRITE.IDLE_MS);
  }, [dispatch, onGlyph, onNodePulse, endComposition]);

  const onStroke = useCallback(
    (stroke: Stroke) => {
      if (stroke.length < 2) return;
      // New ink far from the current composition ends it — the next commit
      // starts a fresh text node where the writer actually is.
      const cur = compRef.current;
      if (cur && bufferRef.current.length === 0) {
        const start: Point = stroke[0]!;
        if (isFarFrom(cur.extent, start, cur.em)) endComposition();
      }
      bufferRef.current = [...bufferRef.current, stroke];
      setBuffer(bufferRef.current);
      clearTimer(idleTimer);
      clearTimer(commitTimer);
      commitTimer.current = window.setTimeout(commitGlyph, WRITE.COMMIT_MS);
    },
    [commitGlyph, endComposition],
  );

  const backspace = useCallback((): boolean => {
    const cur = compRef.current;
    if (!cur) return false;
    const label = cur.label.replace(/ $/, "").slice(0, -1).replace(/ $/, "");
    if (label === "") {
      dispatch({ type: "delete-node", id: cur.nodeId });
      endComposition();
      return true;
    }
    const next = { ...cur, label };
    compRef.current = next;
    setComp(next);
    dispatch({ type: "set-label", id: cur.nodeId, label });
    dispatch({
      type: "resize-node",
      id: cur.nodeId,
      x: cur.x,
      y: cur.y,
      w: textNodeWidth(label, cur.fontSize),
      h: cur.h,
    });
    clearTimer(idleTimer);
    idleTimer.current = window.setTimeout(endComposition, WRITE.IDLE_MS);
    return true;
  }, [dispatch, endComposition]);

  const flush = useCallback(() => {
    if (bufferRef.current.length > 0) commitGlyph();
    endComposition();
  }, [commitGlyph, endComposition]);

  // Baseline guide: under the composition (and any pending ink).
  let guide: WriteGuide | null = null;
  if (comp) {
    const y = comp.y + comp.h + 6;
    guide = { x1: comp.x, x2: Math.max(comp.x + textNodeWidth(comp.label, comp.fontSize), comp.extent.x + comp.extent.w) + comp.em, y };
  } else if (buffer.length > 0) {
    const b = bbox(buffer.flat());
    guide = { x1: b.x - 8, x2: b.x + Math.max(b.w, b.h) + 24, y: b.y + b.h + 8 };
  }

  return { buffer, guide, composing: comp !== null || buffer.length > 0, onStroke, backspace, flush };
}
