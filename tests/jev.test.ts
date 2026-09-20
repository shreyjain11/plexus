import { describe, expect, it } from "vitest";
import { parseRemote, remoteDisabled, resetRemote } from "../src/voice/remote";
import {
  DESTRUCTIVE_CONFIDENCE,
  NO_SPAN,
  buildRequest,
  decode,
  labelSpans,
} from "../src/voice/jev";
import { MOVE_STEP, SWATCH } from "../src/voice/grammar";
import type { VoiceOp } from "../src/voice/ops";

// ---------------------------------------------------------------------------
// helpers
//
// Jev's wire answers, faked. `choice` carries a confidence; `noul` is a bare
// probability, exactly as the API returns them.
// ---------------------------------------------------------------------------

const choice = (value: string, confidence = 0.95) => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});

const noul = (p: number) => ({ type: "noul", noul: p });

/** Decode a fake response against the spans the request would have offered. */
function run(
  utterance: string,
  answers: Record<string, unknown>,
  labels: string[] = [],
): { ops: VoiceOp[]; confidence: number; intent: string } {
  const { spans } = buildRequest(utterance, labels);
  return decode({ model: "jev-1.13.0", answers }, utterance, spans);
}

// ---------------------------------------------------------------------------
// candidate spans
// ---------------------------------------------------------------------------

describe("label span extraction", () => {
  it("offers the payload words and not the words introducing them", () => {
    const spans = labelSpans("put up a box that says hot path");
    expect(spans).toContain("hot path");
    expect(spans).toContain("path");
    // Never starts or ends on filler.
    expect(spans).not.toContain("a box");
    expect(spans).not.toContain("that says hot");
    expect(spans.every((s) => s.trim() === s && s !== "")).toBe(true);
  });

  it("covers interior filler rather than splitting on it", () => {
    // "cost of goods" has filler in the middle; dropping it would make the
    // right answer unofferable, and the model cannot pick what is not there.
    expect(labelSpans("add a note saying cost of goods")).toContain("cost of goods");
  });

  it("never offers the same option twice", () => {
    // "ship the widget, then ship it" yields "ship" from two places.
    const spans = labelSpans("ship the widget then ship it");
    expect(new Set(spans).size).toBe(spans.length);
    expect(spans.filter((s) => s === "ship")).toHaveLength(1);
  });

  it("stays inside the option budget", () => {
    expect(labelSpans("alpha bravo charlie delta echo foxtrot golf hotel", 5)).toHaveLength(5);
    // Choice tops out at 255 options and the budget must hold for any input.
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    expect(labelSpans(long).length).toBeLessThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// request shape
// ---------------------------------------------------------------------------

describe("building the batched request", () => {
  it("always offers an escape hatch on the intent", () => {
    const { questions } = buildRequest("do a barrel roll", []);
    const intent = questions.intent;
    expect(intent?.type).toBe("choice");
    expect(intent && "criteria" in intent ? Object.keys(intent.criteria) : []).toContain("none");
  });

  it("omits the item questions when the canvas is empty", () => {
    const { questions } = buildRequest("delete that", []);
    expect(questions.target).toBeUndefined();
    expect(questions.connect_from).toBeUndefined();
  });

  it("asks which item only when there is something to point at", () => {
    const one = buildRequest("delete that", ["Intake"]).questions;
    expect(one.target).toBeDefined();
    // Presence is asked apart from identity, so the identity options are all
    // real items and genuinely compete with one another.
    expect(one.target_named?.type).toBe("noul");
    const options = one.target && "criteria" in one.target ? Object.keys(one.target.criteria) : [];
    expect(options).toEqual(["Intake"]);
    // One item is not enough for a two-ended connector.
    expect(one.connect_from).toBeUndefined();

    const two = buildRequest("wire those up", ["Intake", "Review"]).questions;
    expect(two.connect_from).toBeDefined();
    expect(two.connect_to).toBeDefined();
  });

  it("puts the utterance and the item labels in the state, deduped", () => {
    const { state } = buildRequest("tidy", ["Intake", "Intake", "  ", "Review"]);
    expect(state.utterance).toBe("tidy");
    expect(state.existing_items).toEqual(["Intake", "Review"]);
  });

  it("offers every span plus a no-label option", () => {
    const { questions, spans } = buildRequest("a box saying hot path", []);
    const q = questions.label_span;
    const options = q && "criteria" in q ? Object.keys(q.criteria) : [];
    for (const s of spans) expect(options).toContain(s);
    expect(options).toContain(NO_SPAN);
  });
});

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

describe("decoding answers into ops", () => {
  it("does nothing when the utterance is not a command", () => {
    const out = run("what did you have for lunch", { intent: choice("none") });
    expect(out.ops).toEqual([]);
    expect(out.intent).toBe("none");
  });

  it("does nothing when the answers are malformed", () => {
    expect(decode(null, "x", []).ops).toEqual([]);
    expect(decode({ answers: { intent: { type: "choice" } } }, "x", []).ops).toEqual([]);
    expect(decode({ answers: {} }, "x", []).ops).toEqual([]);
  });

  it("creates a shape, taking the label from the chosen span", () => {
    const out = run("chuck up a database for hot path", {
      intent: choice("add"),
      shape_stated: noul(0.97),
      shape: choice("cylinder"),
      label_span: choice("hot path"),
    });
    expect(out.ops).toEqual([{ op: "add", shape: "cylinder", label: "Hot Path" }]);
  });

  it("falls back to a plain box when no shape was stated", () => {
    const out = run("stick something on the canvas", {
      intent: choice("add"),
      shape_stated: noul(0.1),
      shape: choice("hexagon"),
      label_span: choice(NO_SPAN),
    });
    expect(out.ops).toEqual([{ op: "add", shape: "rect" }]);
  });

  it("ignores a label span that was never offered", () => {
    const out = run("stick a box up", {
      intent: choice("add"),
      shape_stated: noul(0.9),
      shape: choice("rect"),
      label_span: choice("a label nobody proposed"),
    });
    expect(out.ops).toEqual([{ op: "add", shape: "rect" }]);
  });

  it("maps a colour name onto the canvas swatch", () => {
    const out = run(
      "give that thing a bit of colour",
      {
        intent: choice("fill"),
        color_stated: noul(0.9),
        color: choice("orange"),
        target_named: noul(0.05),
        target: choice("Intake"),
      },
      ["Intake"],
    );
    // They pointed rather than named, so the op leaves the target implicit and
    // the app applies it to the selection.
    expect(out.ops).toEqual([{ op: "fill", color: SWATCH.orange }]);
  });

  it("does not let an unread item choice drag the confidence down", () => {
    // With one item on the canvas, "that one" and "Intake" describe the same
    // node, so the identity answer can be a coin flip. It is an unused branch:
    // presence already said they named nothing.
    const out = run(
      "make that one orange",
      {
        intent: choice("fill", 0.99),
        color_stated: noul(0.98),
        color: choice("orange", 0.99),
        target_named: noul(0.06),
        target: choice("Intake", 0.12),
      },
      ["Intake"],
    );
    expect(out.ops).toEqual([{ op: "fill", color: SWATCH.orange }]);
    expect(out.confidence).toBeGreaterThan(0.9);
  });

  it("does not fill when no colour was actually mentioned", () => {
    const out = run("do something to that", {
      intent: choice("fill"),
      color_stated: noul(0.2),
      color: choice("blue"),
    });
    expect(out.ops).toEqual([]);
  });

  it("resolves a vague reference to a named item", () => {
    const out = run(
      "scrap the storage thing",
      { intent: choice("delete", 0.93), target_named: noul(0.97), target: choice("Store", 0.88) },
      ["Intake", "Store"],
    );
    expect(out.ops).toEqual([{ op: "delete", target: "Store" }]);
    expect(out.confidence).toBeCloseTo(0.88);
  });

  it("holds destructive commands to a higher bar", () => {
    const shaky = 0.7;
    expect(shaky).toBeLessThan(DESTRUCTIVE_CONFIDENCE);

    const deleted = run("bin it", { intent: choice("delete", shaky) }, ["Intake"]);
    expect(deleted.ops).toEqual([]);
    expect(deleted.confidence).toBeCloseTo(shaky);

    // The same shakiness is fine for something harmless and undoable.
    const duped = run("another one of those", { intent: choice("duplicate", shaky) }, ["Intake"]);
    expect(duped.ops).toEqual([{ op: "duplicate" }]);
  });

  it("does not let a shaky harmless preference veto the command", () => {
    // Torn between two colours, but certain the user asked for a colour.
    const out = run(
      "make it a sort of bluey purple",
      {
        intent: choice("fill", 0.95),
        color_stated: noul(0.95),
        color: choice("purple", 0.34),
        target_named: noul(0.04),
      },
      ["Intake"],
    );
    expect(out.ops).toEqual([{ op: "fill", color: SWATCH.purple }]);
    expect(out.confidence).toBeCloseTo(0.95);
  });

  it("connects two distinct items and honours a plain-line request", () => {
    const out = run(
      "run a plain line between those two",
      {
        intent: choice("connect"),
        connect_from: choice("Intake", 0.9),
        connect_to: choice("Review", 0.86),
        arrowhead: noul(0.05),
      },
      ["Intake", "Review"],
    );
    expect(out.ops).toEqual([{ op: "connect", chain: ["Intake", "Review"], arrow: false }]);
    expect(out.confidence).toBeCloseTo(0.86);
  });

  it("refuses a connector it cannot ground in two different items", () => {
    const same = run(
      "wire it up",
      { intent: choice("connect"), connect_from: choice("Intake"), connect_to: choice("Intake") },
      ["Intake", "Review"],
    );
    expect(same.ops).toEqual([]);

    // Nothing to connect to at all — Jev cannot invent an endpoint.
    const empty = run("wire it up", { intent: choice("connect") }, []);
    expect(empty.ops).toEqual([]);
  });

  it("will not rename without a label to rename to", () => {
    const out = run("call it something else", {
      intent: choice("rename"),
      label_span: choice(NO_SPAN),
    });
    expect(out.ops).toEqual([]);
  });

  it("skips a select that would not change the selection", () => {
    const out = run("that one", { intent: choice("select"), target_named: noul(0.03) }, ["Intake"]);
    expect(out.ops).toEqual([]);
  });

  it("turns a direction into a nudge", () => {
    const out = run("shove it over a bit", {
      intent: choice("move"),
      direction: choice("right"),
    });
    expect(out.ops).toEqual([{ op: "move", dx: MOVE_STEP, dy: 0 }]);
  });

  it("maps the app-control intents onto their ops", () => {
    const cases: Array<[string, VoiceOp]> = [
      ["undo", { op: "history", action: "undo" }],
      ["redo", { op: "history", action: "redo" }],
      ["clear", { op: "canvas", action: "clear" }],
      ["sample", { op: "canvas", action: "sample" }],
      ["export_svg", { op: "export", format: "svg" }],
      ["export_png", { op: "export", format: "png" }],
      ["save", { op: "file", action: "save" }],
      ["open", { op: "file", action: "open" }],
      ["theme_dark", { op: "theme", theme: "dark" }],
      ["theme_light", { op: "theme", theme: "light" }],
      ["zoom_in", { op: "zoom", dir: "in" }],
      ["zoom_out", { op: "zoom", dir: "out" }],
      ["zoom_reset", { op: "zoom", dir: "reset" }],
      ["mode_draw", { op: "mode", mode: "draw" }],
      ["mode_write", { op: "mode", mode: "write" }],
      ["arrows_on", { op: "arrows", on: true }],
      ["arrows_off", { op: "arrows", on: false }],
      ["tidy", { op: "tidy" }],
      ["help", { op: "help" }],
    ];
    for (const [intent, op] of cases) {
      // `clear` is destructive, so it needs to clear the higher bar.
      expect(run("…", { intent: choice(intent, 0.95) }).ops, intent).toEqual([op]);
    }
  });

  it("still refuses a shaky clear", () => {
    expect(run("start over maybe", { intent: choice("clear", 0.6) }).ops).toEqual([]);
  });
});

describe("standing down when the route cannot answer", () => {
  // Production taught this one: the route deployed fine and then crashed on
  // import, so it answered 500 rather than the 501 that means "no key here".
  // The client kept asking, once per utterance, forever.
  const withFetch = async (reply: () => Response | Promise<Response>, tries = 4) => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(reply());
    }) as typeof fetch;
    try {
      resetRemote();
      for (let i = 0; i < tries; i += 1) await parseRemote("do a thing", { labels: [] });
      return { calls, disabled: remoteDisabled() };
    } finally {
      globalThis.fetch = real;
      resetRemote();
    }
  };

  it("latches off immediately on 501 — the designed off switch", async () => {
    const { calls, disabled } = await withFetch(() => new Response("{}", { status: 501 }));
    expect(disabled).toBe(true);
    expect(calls).toBe(1);
  });

  it("gives up after three failures of any other kind", async () => {
    const { calls, disabled } = await withFetch(() => new Response("boom", { status: 500 }));
    expect(disabled).toBe(true);
    expect(calls).toBe(3);
  });

  it("counts a network error as a failure too", async () => {
    const { calls, disabled } = await withFetch(() => {
      throw new Error("offline");
    });
    expect(disabled).toBe(true);
    expect(calls).toBe(3);
  });

  it("does not hold a one-off blip against a working route", async () => {
    const real = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (() => {
      n += 1;
      return Promise.resolve(
        n === 1 || n === 3
          ? new Response("boom", { status: 500 })
          : new Response(JSON.stringify({ ops: [] }), { status: 200 }),
      );
    }) as typeof fetch;
    try {
      resetRemote();
      for (let i = 0; i < 6; i += 1) await parseRemote("do a thing", { labels: [] });
      // Failures alternate with successes, so the streak never reaches three.
      expect(remoteDisabled()).toBe(false);
      expect(n).toBe(6);
    } finally {
      globalThis.fetch = real;
      resetRemote();
    }
  });
});
