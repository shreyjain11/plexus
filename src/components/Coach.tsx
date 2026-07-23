/**
 * First-run coach: three quiet hint cards shown while the canvas is empty.
 * Disappears the moment anything exists (or is dismissed).
 */
export function Coach({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="coach" role="note" aria-label="Getting started hints">
      <button type="button" className="coach__close" onClick={onDismiss} aria-label="Dismiss hints">
        ×
      </button>
      <div className="coach__card">
        <span className="coach__step">01</span>
        <strong>Sketch it rough.</strong> Draw a box, blob, or line — Plexus snaps it into a clean
        shape or arrow.
      </div>
      <div className="coach__card">
        <span className="coach__step">02</span>
        <strong>Draw in the air.</strong> Enable hand tracking, then pinch thumb + index to ink.
        Pinch with <em>both</em> hands to frame a shape between them.
      </div>
      <div className="coach__card">
        <span className="coach__step">03</span>
        <strong>Make it yours.</strong> Double-click to label, drag to arrange, <kbd>T</kbd> for
        text boxes, <kbd>?</kbd> for every shortcut.
      </div>
    </div>
  );
}
