import type { Doc } from "../types";
import { docToSvg } from "./svg";

const SCALE = 2;

/**
 * Rasterize the clean scene to PNG at 2x for crisp bitmaps. The working
 * document itself always stays vector — this only produces a downloadable
 * snapshot, never the editing surface.
 */
export async function downloadPng(doc: Doc, filename = "plexus.png"): Promise<void> {
  const svg = docToSvg(doc);
  const svgBlob = new Blob([svg], { type: "image/svg+xml" });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to rasterize SVG"));
      img.src = svgUrl;
    });

    const vb = /viewBox="([\d.\- ]+)"/.exec(svg);
    let w = img.width;
    let h = img.height;
    if (vb && vb[1]) {
      const parts = vb[1].split(" ").map(Number);
      if (parts.length === 4) {
        w = parts[2]!;
        h = parts[3]!;
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * SCALE));
    canvas.height = Math.max(1, Math.round(h * SCALE));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.scale(SCALE, SCALE);
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG encoding failed");
    const pngUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = pngUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(pngUrl), 4000);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}
