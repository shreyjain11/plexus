import type { Mode } from "./Canvas";
import {
  ArrowIcon,
  ClearIcon,
  CursorIcon,
  ExportIcon,
  ImageIcon,
  LineIcon,
  PenIcon,
  SampleIcon,
  UndoIcon,
} from "./icons";

interface ToolbarProps {
  mode: Mode;
  onMode: (m: Mode) => void;
  arrow: boolean;
  onArrow: (v: boolean) => void;
  canUndo: boolean;
  onUndo: () => void;
  onClear: () => void;
  onExportSvg: () => void;
  onExportPng: () => void;
  onLoadSample: () => void;
}

export function Toolbar({
  mode,
  onMode,
  arrow,
  onArrow,
  canUndo,
  onUndo,
  onClear,
  onExportSvg,
  onExportPng,
  onLoadSample,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar__group" role="radiogroup" aria-label="Tool">
        <button
          type="button"
          className={`tool ${mode === "draw" ? "tool--active" : ""}`}
          role="radio"
          aria-checked={mode === "draw"}
          onClick={() => onMode("draw")}
          title="Draw (D)"
        >
          <PenIcon />
          <span className="tool__label">Draw</span>
          <kbd className="tool__key">D</kbd>
        </button>
        <button
          type="button"
          className={`tool ${mode === "select" ? "tool--active" : ""}`}
          role="radio"
          aria-checked={mode === "select"}
          onClick={() => onMode("select")}
          title="Select (V)"
        >
          <CursorIcon />
          <span className="tool__label">Select</span>
          <kbd className="tool__key">V</kbd>
        </button>
      </div>

      <div className="toolbar__group">
        <button
          type="button"
          className={`tool tool--toggle ${arrow ? "tool--on" : ""}`}
          role="switch"
          aria-checked={arrow}
          onClick={() => onArrow(!arrow)}
          title="Arrowheads on new connectors (A)"
        >
          {arrow ? <ArrowIcon /> : <LineIcon />}
          <span className="tool__label">{arrow ? "Arrows" : "Lines"}</span>
          <kbd className="tool__key">A</kbd>
        </button>
      </div>

      <div className="toolbar__group">
        <button
          type="button"
          className="tool"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (⌘/Ctrl-Z)"
        >
          <UndoIcon />
          <span className="tool__label">Undo</span>
          <kbd className="tool__key">⌘Z</kbd>
        </button>
        <button type="button" className="tool" onClick={onClear} title="Clear canvas">
          <ClearIcon />
          <span className="tool__label">Clear</span>
        </button>
      </div>

      <div className="toolbar__group">
        <button type="button" className="tool" onClick={onExportSvg} title="Export SVG (⌘/Ctrl-E)">
          <ExportIcon />
          <span className="tool__label">SVG</span>
          <kbd className="tool__key">⌘E</kbd>
        </button>
        <button type="button" className="tool" onClick={onExportPng} title="Export PNG">
          <ImageIcon />
          <span className="tool__label">PNG</span>
        </button>
      </div>

      <div className="toolbar__group">
        <button type="button" className="tool tool--accent" onClick={onLoadSample} title="Load a sample pathway">
          <SampleIcon />
          <span className="tool__label">Sample</span>
        </button>
      </div>
    </div>
  );
}
