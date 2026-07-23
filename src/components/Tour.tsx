import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Interactive onboarding tour.
 *
 * Not a slideshow: each step names a real action ("draw a box") and the tour
 * watches the live document snapshot, ticking itself forward the moment the
 * user actually does the thing. A full-screen veil with an animated mask
 * cutout spotlights the relevant UI — and the veil is pointer-transparent,
 * because the whole point is that you keep drawing *through* it. Only the
 * instruction card takes pointer events.
 */

export const TOUR_KEY = "plexus.tour.v3";

export interface TourSnapshot {
  nodes: number;
  edges: number;
  /** Count of non-empty node + edge labels. */
  labeled: number;
  /** Committed Write-mode glyphs this session. */
  glyphs: number;
  handRunning: boolean;
}

interface Step {
  id: string;
  /** data-tour attribute of the element to spotlight; null = centered card. */
  target: string | null;
  eyebrow: string;
  title: string;
  body: string;
  /** Completion predicate against the live snapshot and the step-entry baseline. */
  done?: (snap: TourSnapshot, base: TourSnapshot) => boolean;
  /** Label for the manual advance button. */
  nextLabel?: string;
}

const STEPS: readonly Step[] = [
  {
    id: "welcome",
    target: null,
    eyebrow: "PLEXUS",
    title: "Draw diagrams in the air.",
    body: "Rough ink in — clean, editable figures out. This 60-second tour walks the four moves that matter. Everything stays interactive: you do each one for real.",
    nextLabel: "Start the tour",
  },
  {
    id: "draw",
    target: "canvas",
    eyebrow: "01 · SKETCH",
    title: "Draw a box on the canvas.",
    body: "Rough is fine — a wobbly rectangle, circle, diamond, triangle, or hexagon all snap into clean shapes the moment you let go.",
    done: (s, b) => s.nodes > b.nodes,
  },
  {
    id: "connect",
    target: "canvas",
    eyebrow: "02 · CONNECT",
    title: "Link two shapes with a stroke.",
    body: "Draw a second shape, then a line from inside one to inside the other. It becomes an arrow that stays attached when you move things.",
    done: (s, b) => s.edges > b.edges,
  },
  {
    id: "label",
    target: "canvas",
    eyebrow: "03 · LABEL",
    title: "Double-click anything to name it.",
    body: "Nodes and connectors both take labels. Enter commits, Esc cancels.",
    done: (s, b) => s.labeled > b.labeled,
  },
  {
    id: "write",
    target: "write",
    eyebrow: "04 · WRITE",
    title: "Hand-write a letter.",
    body: "Switch to Write (W) and draw a big letter on the canvas. Pause a beat — Plexus reads it and types it as real text. Keep writing to spell words.",
    done: (s, b) => s.glyphs > b.glyphs,
  },
  {
    id: "air",
    target: "camera",
    eyebrow: "05 · AIR",
    title: "Now try it in the air.",
    body: "Enable hand tracking and pinch thumb + index to ink. Pinch with both hands at once to frame a shape between them. (No camera handy? Skip ahead.)",
    done: (s) => s.handRunning,
  },
  {
    id: "done",
    target: null,
    eyebrow: "CERTIFIED",
    title: "You draw like an engineer now.",
    body: "Press ? anytime for every shortcut, and ⌘K for the command palette. Your work autosaves in this browser.",
    nextLabel: "Start diagramming",
  },
];

interface Hole {
  x: number;
  y: number;
  w: number;
  h: number;
}

const HOLE_PAD = 10;

export function Tour({
  snap,
  onClose,
  reducedMotion,
}: {
  snap: TourSnapshot;
  onClose: (completed: boolean) => void;
  reducedMotion: boolean;
}) {
  const [idx, setIdx] = useState(0);
  const [ticked, setTicked] = useState(false);
  const [hole, setHole] = useState<Hole | null>(null);
  const base = useRef<TourSnapshot>(snap);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const advanceTimer = useRef<number | null>(null);

  const step = STEPS[idx]!;
  const interactiveSteps = STEPS.filter((s) => s.done).length;
  const stepNumber = STEPS.slice(0, idx + 1).filter((s) => s.done).length;

  const goto = useCallback((next: number) => {
    if (advanceTimer.current !== null) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    base.current = snapRef.current;
    setTicked(false);
    setIdx(next);
  }, []);

  const finish = useCallback(
    (completed: boolean) => {
      try {
        localStorage.setItem(TOUR_KEY, "done");
      } catch {
        /* best-effort */
      }
      onClose(completed);
    },
    [onClose],
  );

  // Auto-advance the moment the step's action actually happens.
  useEffect(() => {
    if (!step.done || ticked) return;
    if (!step.done(snap, base.current)) return;
    setTicked(true);
    advanceTimer.current = window.setTimeout(
      () => goto(Math.min(idx + 1, STEPS.length - 1)),
      reducedMotion ? 250 : 850,
    );
  }, [snap, step, ticked, idx, goto, reducedMotion]);

  useEffect(
    () => () => {
      if (advanceTimer.current !== null) clearTimeout(advanceTimer.current);
    },
    [],
  );

  // Measure the spotlight target; follow it through resizes.
  useLayoutEffect(() => {
    if (!step.target) {
      setHole(null);
      return;
    }
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (!el) {
      setHole(null);
      return;
    }
    const measure = () => {
      const r = el.getBoundingClientRect();
      setHole({
        x: r.left - HOLE_PAD,
        y: r.top - HOLE_PAD,
        w: r.width + HOLE_PAD * 2,
        h: r.height + HOLE_PAD * 2,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [step.target]);

  // Card placement: centered for card steps; otherwise beside/below the hole.
  const cardStyle: React.CSSProperties = {};
  let cardClass = "tour-card";
  if (!hole) {
    cardClass += " tour-card--center";
  } else {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const below = hole.y + hole.h + 20;
    if (hole.w > vw * 0.6) {
      // Wide target (the canvas): tuck the card to its lower-left.
      cardStyle.left = Math.max(16, hole.x + 24);
      cardStyle.top = Math.min(vh - 220, hole.y + hole.h - 190);
    } else if (below + 200 < vh) {
      cardStyle.left = Math.min(Math.max(16, hole.x), vw - 356);
      cardStyle.top = below;
    } else {
      cardStyle.left = Math.min(hole.x + hole.w + 20, vw - 356);
      cardStyle.top = Math.max(16, Math.min(hole.y, vh - 240));
    }
  }

  return (
    <div className="tour" aria-live="polite">
      <svg className="tour__veil" width="100%" height="100%" aria-hidden="true">
        <defs>
          <mask id="tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="#fff" />
            {hole && (
              <rect
                className={reducedMotion ? "tour__hole" : "tour__hole tour__hole--springy"}
                x={hole.x}
                y={hole.y}
                width={hole.w}
                height={hole.h}
                rx="14"
                fill="#000"
              />
            )}
          </mask>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" className="tour__dim" mask="url(#tour-mask)" />
        {hole && (
          <rect
            className={reducedMotion ? "tour__ring" : "tour__ring tour__ring--springy"}
            x={hole.x}
            y={hole.y}
            width={hole.w}
            height={hole.h}
            rx="14"
          />
        )}
      </svg>

      <div className={cardClass} style={cardStyle} role="dialog" aria-label={`Tour: ${step.title}`}>
        <div className="tour-card__eyebrow">
          <span>{step.eyebrow}</span>
          {step.done && (
            <span className="tour-card__count">
              {String(stepNumber).padStart(2, "0")} / {String(interactiveSteps).padStart(2, "0")}
            </span>
          )}
        </div>
        <h2 className="tour-card__title">
          {step.title}
          {ticked && (
            <span className="tour-card__tick" aria-label="Done">
              ✓
            </span>
          )}
        </h2>
        <p className="tour-card__body">{step.body}</p>

        {step.done && (
          <div className="tour-card__rail" aria-hidden="true">
            <div
              className="tour-card__rail-fill"
              style={{ width: `${((stepNumber - (ticked ? 0 : 1)) / interactiveSteps) * 100}%` }}
            />
          </div>
        )}

        <div className="tour-card__actions">
          {idx === 0 && (
            <>
              <button type="button" className="tour-btn tour-btn--primary" onClick={() => goto(1)}>
                {step.nextLabel}
              </button>
              <button type="button" className="tour-btn" onClick={() => finish(false)}>
                Skip — just draw
              </button>
            </>
          )}
          {idx > 0 && idx < STEPS.length - 1 && (
            <>
              <button type="button" className="tour-btn" onClick={() => goto(idx - 1)}>
                Back
              </button>
              <button
                type="button"
                className="tour-btn"
                onClick={() => goto(idx + 1)}
                title="Skip this step"
              >
                {ticked ? "Next" : "Skip step"}
              </button>
              <button type="button" className="tour-btn tour-btn--quiet" onClick={() => finish(false)}>
                End tour
              </button>
            </>
          )}
          {idx === STEPS.length - 1 && (
            <button type="button" className="tour-btn tour-btn--primary" onClick={() => finish(true)}>
              {step.nextLabel}
            </button>
          )}
        </div>
      </div>

      {idx === STEPS.length - 1 && !reducedMotion && (
        <div className="tour-stamp" aria-hidden="true">
          PLEXUS · CERTIFIED
        </div>
      )}
    </div>
  );
}
