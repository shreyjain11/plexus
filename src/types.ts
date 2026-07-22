export interface Point {
  x: number;
  y: number;
}

/** A raw input stroke in scene coordinates, ordered by time. */
export type Stroke = Point[];

export type NodeType = "rect" | "ellipse";

export interface DiagramNode {
  id: string;
  type: NodeType;
  /** Top-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

/** An edge endpoint: either attached to a node or a free point in the scene. */
export type NodeRef = { node: string };
export type EdgeEnd = NodeRef | Point;

export interface DiagramEdge {
  id: string;
  from: EdgeEnd;
  to: EdgeEnd;
  arrow: boolean;
}

export interface Doc {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export function isNodeRef(end: EdgeEnd): end is NodeRef {
  return "node" in end;
}

export const EMPTY_DOC: Doc = { nodes: [], edges: [] };
