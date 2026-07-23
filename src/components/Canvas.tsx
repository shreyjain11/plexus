import { useCallback, useEffect, useRef, useState } from "react";
import type { DiagramEdge, DiagramNode, Doc, Point } from "../types";
import type { DocAction, Selection } from "../state/doc";
import type { StrokeInput } from "../input/useStrokeInput";
import { routeEdge } from "../recognition/snap";

export type Mode = "draw" | "select";

interface CanvasProps {
  doc: Doc;
  selection: Selection | null;
  mode: Mode;
  input: StrokeInput;
  dispatch: React.Dispatch<DocAction>;
  ghost: readonly Point[] | null;
  justAddedId: string | null;
  cursor: Point | null;
  penDown: boolean;
  reducedMotion: boolean;
}

const DRAG_THRESHOLD = 3;

export function Canvas({
  doc,
  selection,
  mode,
  input,
  dispatch,
  ghost,
  justAddedId,
  cursor,
  penDown,
  reducedMotion,
}: CanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 1000, h: 700 });
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);

  // Track the container size so the viewBox maps 1:1 to CSS pixels.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toScene = useCallback((clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    if (!svg) return { x: clientX, y: clientY };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: clientX, y: clientY };
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }, []);

  // Drag bookkeeping for select-mode node moves.
  const drag = useRef<{
    id: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  const nodesById = new Map(doc.nodes.map((n) => [n.id, n]));

  const commitLabel = useCallback(() => {
    setEditing((cur) => {
      if (cur) dispatch({ type: "set-label", id: cur.id, label: cur.draft.trim() });
      return null;
    });
  }, [dispatch]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (editing) return;
      if (e.button !== undefined && e.button !== 0) return;
      const p = toScene(e.clientX, e.clientY);
      svgRef.current?.setPointerCapture(e.pointerId);

      if (mode === "draw") {
        input.begin(p);
        return;
      }

      // Select mode: figure out what was hit via data attributes.
      const target = e.target as Element;
      const nodeEl = target.closest("[data-node-id]");
      const edgeEl = target.closest("[data-edge-id]");
      if (nodeEl) {
        const id = nodeEl.getAttribute("data-node-id")!;
        const node = nodesById.get(id);
        if (node) {
          dispatch({ type: "select", selection: { kind: "node", id } });
          drag.current = {
            id,
            startX: p.x,
            startY: p.y,
            originX: node.x,
            originY: node.y,
            moved: false,
          };
        }
      } else if (edgeEl) {
        dispatch({ type: "select", selection: { kind: "edge", id: edgeEl.getAttribute("data-edge-id")! } });
      } else {
        dispatch({ type: "select", selection: null });
      }
    },
    [editing, mode, input, toScene, dispatch, nodesById],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (mode === "draw") {
        if (input.live) input.extend(toScene(e.clientX, e.clientY));
        return;
      }
      const d = drag.current;
      if (!d) return;
      const p = toScene(e.clientX, e.clientY);
      if (!d.moved && Math.hypot(p.x - d.startX, p.y - d.startY) < DRAG_THRESHOLD) return;
      if (!d.moved) {
        d.moved = true;
        dispatch({ type: "start-move", id: d.id }); // one undo snapshot per drag
      }
      dispatch({ type: "move-node", id: d.id, x: d.originX + (p.x - d.startX), y: d.originY + (p.y - d.startY) });
    },
    [mode, input, toScene, dispatch],
  );

  const endPointer = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (svgRef.current?.hasPointerCapture(e.pointerId)) {
        svgRef.current.releasePointerCapture(e.pointerId);
      }
      if (mode === "draw") {
        if (input.live) input.end();
      } else {
        drag.current = null;
      }
    },
    [mode, input],
  );

  const openEditor = useCallback((node: DiagramNode) => {
    setEditing({ id: node.id, draft: node.label });
  }, []);

  const strokePath = (pts: readonly Point[]): string =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

  const dotScale = 22;

  return (
    <svg
      ref={svgRef}
      className={`canvas canvas--${mode}`}
      viewBox={`0 0 ${size.w} ${size.h}`}
      preserveAspectRatio="xMidYMid slice"
      role="application"
      aria-label={`Plexus drawing surface, ${mode} mode`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      <defs>
        <pattern id="plexus-dots" width={dotScale} height={dotScale} patternUnits="userSpaceOnUse">
          <circle cx={1} cy={1} r={1} fill="var(--paper-dot)" />
        </pattern>
        <marker
          id="plexus-arrow-live"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink)" />
        </marker>
      </defs>

      <rect className="canvas__bg" x={0} y={0} width={size.w} height={size.h} fill="url(#plexus-dots)" />

      {/* Edges under nodes so arrowheads meet borders cleanly. */}
      <g>
        {doc.edges.map((edge) => (
          <EdgeView
            key={edge.id}
            edge={edge}
            nodesById={nodesById}
            selected={selection?.kind === "edge" && selection.id === edge.id}
            justAdded={justAddedId === edge.id && !reducedMotion}
          />
        ))}
      </g>

      <g>
        {doc.nodes.map((node) => (
          <NodeView
            key={node.id}
            node={node}
            selected={selection?.kind === "node" && selection.id === node.id}
            justAdded={justAddedId === node.id && !reducedMotion}
            editing={editing?.id === node.id}
            onOpenEditor={openEditor}
          />
        ))}
      </g>

      {/* Ghost: the raw stroke fading out as the clean shape snaps in. */}
      {ghost && !reducedMotion && (
        <path className="stroke-ghost" d={strokePath(ghost)} fill="none" />
      )}

      {/* Live in-progress stroke. */}
      {input.live && input.live.length > 0 && (
        <path className="stroke-live" d={strokePath(input.live)} fill="none" />
      )}

      {/* Hand cursor reticle. */}
      {cursor && (
        <g className="reticle" transform={`translate(${cursor.x} ${cursor.y})`} aria-hidden="true">
          <circle className={`reticle__ring ${penDown ? "reticle__ring--down" : ""}`} r={penDown ? 8 : 12} />
          <circle className="reticle__dot" r={2} />
        </g>
      )}

      {editing && (
        <LabelEditor
          node={nodesById.get(editing.id)!}
          draft={editing.draft}
          onChange={(draft) => setEditing((cur) => (cur ? { ...cur, draft } : cur))}
          onCommit={commitLabel}
          onCancel={() => setEditing(null)}
        />
      )}
    </svg>
  );
}

function NodeView({
  node,
  selected,
  justAdded,
  editing,
  onOpenEditor,
}: {
  node: DiagramNode;
  selected: boolean;
  justAdded: boolean;
  editing: boolean;
  onOpenEditor: (n: DiagramNode) => void;
}) {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  const cls = `node ${selected ? "node--selected" : ""} ${justAdded ? "node--snap" : ""}`;
  return (
    <g
      className={cls}
      data-node-id={node.id}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpenEditor(node);
      }}
    >
      {node.type === "ellipse" ? (
        <ellipse className="node__shape" cx={cx} cy={cy} rx={node.w / 2} ry={node.h / 2} />
      ) : (
        <rect className="node__shape" x={node.x} y={node.y} width={node.w} height={node.h} rx={8} />
      )}
      {!editing && node.label && (
        <text className="node__label" x={cx} y={cy} textAnchor="middle" dominantBaseline="central">
          {node.label}
        </text>
      )}
    </g>
  );
}

function EdgeView({
  edge,
  nodesById,
  selected,
  justAdded,
}: {
  edge: DiagramEdge;
  nodesById: Map<string, DiagramNode>;
  selected: boolean;
  justAdded: boolean;
}) {
  const r = routeEdge(edge, nodesById);
  if (!r) return null;
  return (
    <g className={`edge ${selected ? "edge--selected" : ""} ${justAdded ? "edge--snap" : ""}`} data-edge-id={edge.id}>
      <line className="edge__hit" x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} />
      <line
        className="edge__line"
        x1={r.x1}
        y1={r.y1}
        x2={r.x2}
        y2={r.y2}
        markerEnd={edge.arrow ? "url(#plexus-arrow-live)" : undefined}
      />
    </g>
  );
}

function LabelEditor({
  node,
  draft,
  onChange,
  onCommit,
  onCancel,
}: {
  node: DiagramNode;
  draft: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, []);
  return (
    <foreignObject x={node.x} y={node.y + node.h / 2 - 16} width={node.w} height={32}>
      <input
        ref={inputRef}
        className="label-editor"
        value={draft}
        placeholder="label…"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          e.stopPropagation();
        }}
      />
    </foreignObject>
  );
}
