import { useEffect, useRef } from "react";

const SHORTCUTS: Array<[string, string]> = [
  ["D", "Draw mode"],
  ["V / S", "Select mode"],
  ["T", "Text tool — click to place a text box"],
  ["W", "Write mode — hand-write letters & digits"],
  ["⌫ (writing)", "Erase the last written character"],
  ["A", "Toggle arrowheads on new connectors"],
  ["⌘/Ctrl K", "Command palette — every action, fuzzy-searched"],
  ["⌘/Ctrl Z", "Undo"],
  ["⌘/Ctrl ⇧ Z", "Redo"],
  ["⌘/Ctrl D", "Duplicate selection"],
  ["⌘/Ctrl S", "Save diagram as JSON"],
  ["⌘/Ctrl O", "Open a saved diagram"],
  ["⌘/Ctrl E", "Export SVG"],
  ["Delete / ⌫", "Delete selection"],
  ["Arrows", "Nudge selection (⇧ = ×10)"],
  ["⌘/Ctrl + / − / 0", "Zoom in / out / reset"],
  ["Space-drag", "Pan the canvas"],
  ["Esc", "Deselect / close"],
  ["Double-click", "Edit a node or edge label"],
  ["Pinch (hand)", "Draw, or grab a node in Select"],
  ["Both hands pinch", "Frame the armed shape in the air"],
];

export function HelpModal({
  onClose,
  onReplayTour,
}: {
  onClose: () => void;
  onReplayTour: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  return (
    <div
      className="help-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <header className="help__head">
          <h2>Shortcuts</h2>
          <button ref={closeRef} type="button" className="help__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <dl className="help__list">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="help__row">
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <footer className="help__foot">
          <button type="button" className="help__replay" onClick={onReplayTour}>
            Replay the guided tour
          </button>
        </footer>
      </div>
    </div>
  );
}
