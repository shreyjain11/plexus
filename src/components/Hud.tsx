export interface HudReadout {
  label: string;
  tone: "ok" | "warn";
  /** bumped each recognition so identical labels still retrigger the flash. */
  nonce: number;
}

interface HudProps {
  readout: HudReadout | null;
  reducedMotion: boolean;
}

/**
 * The recognized-as readout. Flashes briefly after each stroke resolves,
 * naming what the ink became (or that it was not recognized).
 */
export function Hud({ readout, reducedMotion }: HudProps) {
  if (!readout) return null;
  return (
    <div className="hud" role="status" aria-live="polite">
      <div
        key={reducedMotion ? undefined : readout.nonce}
        className={`hud__chip hud__chip--${readout.tone} ${reducedMotion ? "" : "hud__chip--flash"}`}
      >
        <span className="hud__eyebrow">{readout.tone === "ok" ? "recognized" : "unrecognized"}</span>
        <span className="hud__value">{readout.label}</span>
      </div>
    </div>
  );
}
