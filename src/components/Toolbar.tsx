import type { Mode } from "./Canvas";
import type { NodeType } from "../types";
import {
  ArrowIcon,
  ClearIcon,
  CursorIcon,
  DiamondIcon,
  EllipseIcon,
  ExportIcon,
  HelpIcon,
  ImageIcon,
  LineIcon,
  OpenIcon,
  PenIcon,
  RectIcon,
  RedoIcon,
  SampleIcon,
  SaveIcon,
  TextIcon,
  UndoIcon,
} from "./icons";

export type PaletteShape = Exclude<NodeType, "text">;

interface ToolbarProps {
  mode: Mode;
  onMode: (m: Mode) => void;
  shape: PaletteShape;
  onInsertShape: (t: PaletteShape) => void;
  arrow: boolean;
  onArrow: (v: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onSave: () => void;
  onOpen: () => void;
  onExportSvg: () => void;
  onExportPng: () => void;
  onLoadSample: () => void;
  onHelp: () => void;
}

export function Toolbar({
  mode,
  onMode,
  shape,
  onInsertShape,
  arrow,
  onArrow,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
  onSave,
  onOpen,
  onExportSvg,
  onExportPng,
  onLoadSample,
  onHelp,
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
        <button
          type="button"
          className={`tool ${mode === "text" ? "tool--active" : ""}`}
          role="radio"
          aria-checked={mode === "text"}
          onClick={() => onMode("text")}
          title="Text (T) — click the canvas to place a text box"
        >
          <TextIcon />
          <span className="tool__label">Text</span>
          <kbd className="tool__key">T</kbd>
        </button>
      </div>

      <div className="toolbar__group toolbar__group--row" aria-label="Insert shape">
        <button
          type="button"
          className={`tool tool--shape ${shape === "rect" ? "tool--armed" : ""}`}
          onClick={() => onInsertShape("rect")}
          title="Insert rectangle (also armed for the two-hand frame gesture)"
        >
          <RectIcon />
        </button>
        <button
          type="button"
          className={`tool tool--shape ${shape === "ellipse" ? "tool--armed" : ""}`}
          onClick={() => onInsertShape("ellipse")}
          title="Insert ellipse (also armed for the two-hand frame gesture)"
        >
          <EllipseIcon />
        </button>
        <button
          type="button"
          className={`tool tool--shape ${shape === "diamond" ? "tool--armed" : ""}`}
          onClick={() => onInsertShape("diamond")}
          title="Insert diamond (also armed for the two-hand frame gesture)"
        >
          <DiamondIcon />
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

      <div className="toolbar__group toolbar__group--row">
        <button type="button" className="tool tool--shape" onClick={onUndo} disabled={!canUndo} title="Undo (⌘/Ctrl-Z)">
          <UndoIcon />
        </button>
        <button type="button" className="tool tool--shape" onClick={onRedo} disabled={!canRedo} title="Redo (⌘/Ctrl-Shift-Z)">
          <RedoIcon />
        </button>
        <button type="button" className="tool tool--shape" onClick={onClear} title="Clear canvas">
          <ClearIcon />
        </button>
      </div>

      <div className="toolbar__group">
        <button type="button" className="tool" onClick={onSave} title="Save diagram as JSON (⌘/Ctrl-S)">
          <SaveIcon />
          <span className="tool__label">Save</span>
          <kbd className="tool__key">⌘S</kbd>
        </button>
        <button type="button" className="tool" onClick={onOpen} title="Open a saved diagram (⌘/Ctrl-O)">
          <OpenIcon />
          <span className="tool__label">Open</span>
          <kbd className="tool__key">⌘O</kbd>
        </button>
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
        <button type="button" className="tool" onClick={onHelp} title="Keyboard shortcuts (?)">
          <HelpIcon />
          <span className="tool__label">Help</span>
          <kbd className="tool__key">?</kbd>
        </button>
      </div>
    </div>
  );
}
