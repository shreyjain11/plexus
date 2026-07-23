import type { HandTracking } from "../input/useHandTracking";
import { HandIcon } from "./icons";

/**
 * The hand-tracking control + live preview. Before the user opts in it is a
 * single "Enable hand tracking" button (so no permission prompt fires on
 * load). Once running it shows a mirrored webcam feed with the detected hand
 * skeleton overlaid and a pen up/down indicator. Any failure collapses it to
 * a quiet note; mouse and touch always keep working.
 */
export function CameraPanel({ hand }: { hand: HandTracking }) {
  const { status, errorMessage, penDown, handPresent } = hand;
  const running = status === "running";
  const loading = status === "loading";

  return (
    <section className="camera" aria-label="Hand tracking">
      <div className="camera__head">
        <span>Air drawing</span>
        {running && (
          <button type="button" className="camera__disable" onClick={hand.disable}>
            turn off
          </button>
        )}
      </div>

      {/* The video + overlay always exist so the hook's refs are stable; they
          are only shown while running. */}
      <div className="camera__stage" style={{ display: running ? "block" : "none" }}>
        <video ref={hand.videoRef} className="camera__video" muted playsInline autoPlay />
        <canvas ref={hand.overlayRef} className="camera__overlay" />
        <div className="camera__pill">
          <span className={`camera__pill-dot ${penDown ? "camera__pill-dot--down" : ""}`} />
          {penDown ? "Pen down" : handPresent ? "Hover" : "Show hand"}
        </div>
      </div>

      {!running && (
        <button type="button" className="camera__enable" onClick={hand.enable} disabled={loading}>
          <HandIcon />
          {loading ? "Starting camera…" : "Enable hand tracking"}
        </button>
      )}

      {running && <p className="camera__note">Pinch thumb &amp; index to draw. Open hand to move.</p>}

      {!running && status !== "idle" && status !== "loading" && (
        <p className="camera__note camera__note--warn">
          {errorMessage ?? "Camera unavailable."} Mouse &amp; touch still work.
        </p>
      )}
    </section>
  );
}
