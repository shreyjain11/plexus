import type { DiagramNode, Doc } from "../types";
import { routeEdge } from "../recognition/snap";

const PADDING = 32;
const ARROW_ID = "plexus-arrow";

/** Escape text for inclusion in SVG/XML content. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function extentOf(doc: Doc): Extent {
  const ext: Extent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x: number, y: number) => {
    if (x < ext.minX) ext.minX = x;
    if (y < ext.minY) ext.minY = y;
    if (x > ext.maxX) ext.maxX = x;
    if (y > ext.maxY) ext.maxY = y;
  };
  for (const n of doc.nodes) {
    grow(n.x, n.y);
    grow(n.x + n.w, n.y + n.h);
  }
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  for (const e of doc.edges) {
    const r = routeEdge(e, byId);
    if (!r) continue;
    grow(r.x1, r.y1);
    grow(r.x2, r.y2);
  }
  if (!Number.isFinite(ext.minX)) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  return ext;
}

const LABEL_FAMILY = `font-family="'IBM Plex Mono', ui-monospace, monospace"`;
const LABEL_FONT = `${LABEL_FAMILY} font-size="15" fill="#23262c"`;

function nodeMarkup(n: DiagramNode): string {
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  const fill = n.fill ?? "#ffffff";
  let shape = "";
  if (n.type === "ellipse") {
    shape = `<ellipse cx="${cx}" cy="${cy}" rx="${n.w / 2}" ry="${n.h / 2}" fill="${esc(fill)}" stroke="#23262c" stroke-width="2"/>`;
  } else if (n.type === "rect") {
    shape = `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8" fill="${esc(fill)}" stroke="#23262c" stroke-width="2"/>`;
  } else if (n.type === "diamond") {
    const pts = `${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}`;
    shape = `<polygon points="${pts}" fill="${esc(fill)}" stroke="#23262c" stroke-width="2"/>`;
  }
  // "text" nodes export as pure text — no shape markup at all.
  const label = n.label
    ? `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" ${LABEL_FONT}>${esc(n.label)}</text>`
    : "";
  return shape + label;
}

/**
 * Serialize the clean scene (nodes + routed edges only — no cursor, live
 * stroke, or selection) as a standalone, self-contained SVG string with
 * arrowhead marker defs, a padded viewBox, and a white paper background so it
 * opens as a valid editable figure anywhere.
 */
export function docToSvg(doc: Doc): string {
  const ext = extentOf(doc);
  const x = ext.minX - PADDING;
  const y = ext.minY - PADDING;
  const w = Math.max(1, ext.maxX - ext.minX + PADDING * 2);
  const h = Math.max(1, ext.maxY - ext.minY + PADDING * 2);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));

  const edgeMarkup = doc.edges
    .map((e) => {
      const r = routeEdge(e, byId);
      if (!r) return "";
      const marker = e.arrow ? ` marker-end="url(#${ARROW_ID})"` : "";
      const line = `<line x1="${r.x1}" y1="${r.y1}" x2="${r.x2}" y2="${r.y2}" stroke="#23262c" stroke-width="2" stroke-linecap="round"${marker}/>`;
      if (!e.label) return line;
      const mx = (r.x1 + r.x2) / 2;
      const my = (r.y1 + r.y2) / 2;
      // paint-order halo keeps the label legible where it crosses the line.
      const label = `<text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="central" ${LABEL_FAMILY} font-size="13" fill="#23262c" paint-order="stroke" stroke="#ffffff" stroke-width="5" stroke-linejoin="round">${esc(e.label)}</text>`;
      return line + "\n    " + label;
    })
    .join("\n    ");

  const nodeMarkupStr = doc.nodes.map(nodeMarkup).join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">
  <defs>
    <marker id="${ARROW_ID}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#23262c"/>
    </marker>
  </defs>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>
  <g>
    ${edgeMarkup}
  </g>
  <g>
    ${nodeMarkupStr}
  </g>
</svg>`;
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadSvg(doc: Doc, filename = "plexus.svg"): void {
  const blob = new Blob([docToSvg(doc)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
