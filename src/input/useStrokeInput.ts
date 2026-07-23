import { useCallback, useRef, useState } from "react";
import { isNodeRef, type DiagramNode, type Point } from "../types";
import type { DocAction } from "../state/doc";
import { classifyStroke, type Recognition } from "../recognition/classify";
import { snapEnd } from "../recognition/snap";
import { uid } from "../state/uid";

export interface RecognitionEvent {
  recognition: Recognition;
  /** id of the object added to the doc, if any (for entrance animation). */
  addedId: string | null;
  /** the raw ink, so the UI can fade it out as the clean shape snaps in. */
  stroke: readonly Point[];
}

interface Options {
  dispatch: React.Dispatch<DocAction>;
  /** Latest nodes, read at stroke-end for endpoint snapping. */
  nodesRef: React.RefObject<readonly DiagramNode[]>;
  /** Whether new connectors get arrowheads. */
  arrowRef: React.RefObject<boolean>;
  onResult: (event: RecognitionEvent) => void;
}

export interface StrokeInput {
  /** The in-progress raw stroke, or null when not drawing. */
  live: readonly Point[] | null;
  begin: (p: Point) => void;
  extend: (p: Point) => void;
  end: () => void;
  cancel: () => void;
  /** Drop the last `n` points (release-jerk trimming for hand input). */
  trimTail: (n: number) => void;
}

/**
 * Owns the raw in-progress stroke and runs recognition on stroke-end. Mouse,
 * touch, and hand-tracking input all call begin/extend/end, so every input
 * shares one drawing and recognition path.
 */
export function useStrokeInput({ dispatch, nodesRef, arrowRef, onResult }: Options): StrokeInput {
  const [live, setLive] = useState<readonly Point[] | null>(null);
  const ref = useRef<Point[] | null>(null);

  const begin = useCallback((p: Point) => {
    ref.current = [p];
    setLive(ref.current);
  }, []);

  const extend = useCallback((p: Point) => {
    const cur = ref.current;
    if (!cur) return;
    const last = cur[cur.length - 1]!;
    // Drop sub-pixel duplicates so path-length stats stay meaningful.
    if (Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) return;
    cur.push(p);
    setLive([...cur]);
  }, []);

  const cancel = useCallback(() => {
    ref.current = null;
    setLive(null);
  }, []);

  const trimTail = useCallback((n: number) => {
    const cur = ref.current;
    if (!cur || n <= 0) return;
    // Never trim a stroke away entirely — keep at least two points.
    cur.length = Math.max(2, cur.length - n);
    setLive([...cur]);
  }, []);

  const end = useCallback(() => {
    const stroke = ref.current;
    ref.current = null;
    setLive(null);
    if (!stroke || stroke.length < 2) return;

    let recognition = classifyStroke(stroke);
    let addedId: string | null = null;

    if (recognition.kind === "node") {
      addedId = uid("n");
      dispatch({
        type: "add-node",
        node: {
          id: addedId,
          type: recognition.type,
          x: recognition.x,
          y: recognition.y,
          w: recognition.w,
          h: recognition.h,
          label: "",
        },
      });
    } else if (recognition.kind === "edge") {
      const nodes = nodesRef.current ?? [];
      const from = snapEnd(recognition.from, nodes);
      const to = snapEnd(recognition.to, nodes);
      if (isNodeRef(from) && isNodeRef(to) && from.node === to.node) {
        // Both ends inside one node: a self-loop would render as nothing and
        // silently pollute the doc/undo history — reject it visibly instead.
        recognition = { kind: "reject", reason: "self-edge" };
      } else {
        addedId = uid("e");
        dispatch({
          type: "add-edge",
          edge: { id: addedId, from, to, arrow: arrowRef.current ?? true },
        });
      }
    }

    onResult({ recognition, addedId, stroke });
  }, [dispatch, nodesRef, arrowRef, onResult]);

  return { live, begin, extend, end, cancel, trimTail };
}
