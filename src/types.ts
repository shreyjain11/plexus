export interface Point {
  x: number;
  y: number;
}

/** A raw input stroke in scene coordinates, ordered by time. */
export type Stroke = Point[];

export type NodeType =
  | "rect"
  | "ellipse"
  | "diamond"
  | "triangle"
  | "hexagon"
  | "parallelogram"
  | "cylinder"
  | "text";

export interface DiagramNode {
  id: string;
  type: NodeType;
  /** Top-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** Background fill; defaults to white ("text" nodes ignore it). */
  fill?: string;
  /**
   * Label size in px; defaults to the standard 15. Set by Write mode so
   * air-written text keeps roughly the size it was written at.
   */
  fontSize?: number;
}

/** An edge endpoint: either attached to a node or a free point in the scene. */
export type NodeRef = { node: string };
export type EdgeEnd = NodeRef | Point;

export interface DiagramEdge {
  id: string;
  from: EdgeEnd;
  to: EdgeEnd;
  arrow: boolean;
  label?: string;
}

export interface Doc {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export function isNodeRef(end: EdgeEnd): end is NodeRef {
  return "node" in end;
}

export const EMPTY_DOC: Doc = { nodes: [], edges: [] };

export const MIN_NODE = { w: 40, h: 32 } as const;
export const MIN_TEXT_NODE = { w: 60, h: 28 } as const;

export function minSizeFor(type: NodeType): { w: number; h: number } {
  return type === "text" ? MIN_TEXT_NODE : MIN_NODE;
}
