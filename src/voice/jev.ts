import { MOVE_STEP, SWATCH, presentLabel, type SwatchName } from "./grammar";
import { NODE_TYPES, type VoiceOp } from "./ops";
import type { NodeType } from "../types";

/**
 * Second-tier voice parsing against TypeSafe's Jev, a System One model.
 *
 * Jev does not generate text — it answers *typed questions* about a piece of
 * state: pick one of these options (choice), or how likely is this (noul). So
 * this tier is not "ask a model for JSON and hope". Every branch of the op
 * vocabulary is enumerated as options up front, which means an answer is
 * already a value the planner accepts: there is no repair step, and nothing to
 * hallucinate. `validateOps` still runs afterwards, but it has nothing to
 * catch by construction.
 *
 * One batched request asks everything at once. The questions are independent
 * judgements about the same utterance and cannot see each other's answers,
 * which is fine — code reads only the ones the chosen intent needs, and
 * ignores uncertainty on the branches it didn't take.
 *
 * Free text is the one thing a decision model genuinely cannot supply, so
 * labels use the select-instead-of-generate pattern: code extracts candidate
 * word-runs from the utterance and Jev picks the intended one.
 *
 * Pure and DOM-free. The serverless route builds the request and decodes the
 * answers with this module; the unit tests drive it with no network at all.
 *
 * Docs: https://docs.typesafe.ai/api · https://docs.typesafe.ai/primitives
 */

// ---------------------------------------------------------------------------
// Question vocabulary
// ---------------------------------------------------------------------------

/**
 * Every intent this tier can resolve to, described by *meaning* rather than by
 * restating its own name — the match is semantic, so "get rid of that" has to
 * be able to reach `delete` without sharing a word with it.
 */
const INTENTS: Readonly<Record<string, string>> = {
  add: "put a new shape or box on the canvas — including when they phrase it as a need or a suggestion rather than an order, like “we need a decision here” or “there should be a queue”",
  connect: "join two things already on the canvas with a line or an arrow",
  rename: "change the words written on something",
  fill: "change the colour of something",
  delete: "take a particular thing off the canvas — something that is sitting there now and that they can point to, whether or not they say which one",
  select: "highlight or pick something out, without otherwise changing it",
  duplicate: "make another copy of something",
  move: "shift something a little in some direction",
  tidy: "rearrange or straighten up the whole diagram",
  undo: "take back the change that was just made — they are reversing their own last action rather than picking out a thing to remove, and the giveaway is that they talk about recency: “that last bit”, “what I just did”, “that didn't work”",
  redo: "put back a change that was just taken back",
  clear: "wipe the canvas and start again from nothing",
  sample: "load the ready-made example diagram",
  export_svg: "save a picture of the diagram as a vector file",
  export_png: "save a picture of the diagram as an image file",
  save: "download the diagram as a file to keep",
  open: "load a diagram file back in from disk",
  theme_dark: "switch the app to a dark colour scheme",
  theme_light: "switch the app to a light colour scheme",
  zoom_in: "make everything on screen bigger, look closer",
  zoom_out: "make everything on screen smaller, see more at once",
  zoom_reset: "go back to the normal zoom level",
  mode_draw: "switch to drawing strokes freehand",
  mode_select: "switch to picking things up and moving them around",
  mode_text: "switch to placing a text caption",
  mode_write: "switch to hand-writing letters that get typed out",
  arrows_on: "new connectors should have an arrowhead on the end",
  arrows_off: "new connectors should be plain lines with no arrowhead",
  help: "show the list of commands or keyboard shortcuts",
  none: "none of these — this is not an instruction about the diagram at all",
};

const SHAPE_HINTS: Readonly<Record<NodeType, string>> = {
  rect: "a plain box, block, step or process",
  ellipse: "a circle, oval, bubble, or a start/end marker",
  diamond: "a decision, a branch, a yes/no gate",
  triangle: "a triangle",
  hexagon: "a hexagon, or a preparation step",
  parallelogram: "a slanted box, for an input or an output",
  cylinder: "a database, a data store, a disk",
  text: "a bare caption, with no shape drawn around it",
};

const COLOR_HINTS: Readonly<Record<SwatchName, string>> = {
  blue: "blue, navy, sky, cyan",
  green: "green, mint, teal, emerald",
  orange: "orange, amber, yellow, gold, peach",
  pink: "pink, red, rose, crimson",
  purple: "purple, violet, lavender, indigo",
  grey: "grey, silver, stone",
  auto: "no colour at all — plain, blank, white, default, or clearing an existing fill",
};

const DIRECTIONS: Readonly<Record<string, string>> = {
  left: "towards the left",
  right: "towards the right",
  up: "upwards, towards the top",
  down: "downwards, towards the bottom",
};

/** The `label_span` option meaning "no run of words here is a label". */
export const NO_SPAN = "__none__";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}
export type JevQuestion = ChoiceQuestion | NoulQuestion;

export interface JevBuild {
  state: { utterance: string; existing_items: string[] };
  questions: Record<string, JevQuestion>;
  /** The span options as offered, so the decoder can check what was on the menu. */
  spans: string[];
}

/** Keep option lists bounded. Jev allows 255; nothing here needs close to that. */
const MAX_OPTIONS = 40;
const MAX_SPANS = 40;
const MAX_SPAN_WORDS = 4;

/**
 * Words that never begin or end a label. Trimming candidate spans at these
 * boundaries is what turns "put a box that says hot path" into the candidate
 * "hot path" rather than forty overlapping fragments of the sentence.
 */
const EDGE_FILLER: ReadonlySet<string> = new Set([
  "a", "an", "the", "to", "of", "in", "on", "at", "by", "from", "with", "for",
  "and", "or", "but", "it", "its", "that", "this", "these", "those", "them",
  "is", "are", "be", "was", "were", "do", "does", "did", "can", "could",
  "would", "should", "will", "just", "please", "hey", "ok", "okay", "now",
  "i", "we", "you", "my", "our", "me", "us", "one", "some", "new", "up",
  "down", "left", "right", "over", "there", "here", "then", "also", "about",
  // verbs that introduce a label but are never part of one
  "make", "made", "add", "create", "draw", "put", "drop", "insert", "give",
  "need", "want", "change", "set", "turn", "rename", "call", "called", "name",
  "named", "label", "labeled", "labelled", "say", "says", "saying", "read",
  "reading", "titled", "connect", "link", "join", "delete", "remove", "erase",
  "move", "nudge", "select", "pick", "copy", "duplicate", "clone",
  // shape nouns: a label is almost never the word for the shape holding it
  "box", "shape", "node", "thing", "circle", "oval", "diamond", "square",
  "rectangle", "triangle", "hexagon", "cylinder", "database", "text", "note",
]);

/**
 * Candidate label spans: every contiguous run of 1–4 words that neither starts
 * nor ends on filler, longest-last so short exact phrases are offered first.
 *
 * Coverage matters more than precision here — the model cannot choose a span
 * that was never offered — so the filter only trims the *edges* of a run and
 * never drops an interior word.
 */
export function labelSpans(utterance: string, max = MAX_SPANS): string[] {
  const words = utterance
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w !== "");

  const out: string[] = [];
  const seen = new Set<string>();
  for (let n = 1; n <= MAX_SPAN_WORDS; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const first = words[i];
      const last = words[i + n - 1];
      if (first === undefined || last === undefined) continue;
      if (EDGE_FILLER.has(first) || EDGE_FILLER.has(last)) continue;
      const span = words.slice(i, i + n).join(" ");
      if (seen.has(span)) continue;
      seen.add(span);
      out.push(span);
      if (out.length >= max) return out;
    }
  }
  return out;
}

function describeItems(labels: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (const l of labels) options[l] = `the item labelled “${l}”`;
  return options;
}

/**
 * Build the single batched request. Questions the utterance cannot possibly
 * need are still asked: they run in parallel for one round trip, and the
 * decoder ignores the ones the chosen intent does not read.
 */
export function buildRequest(utterance: string, labels: readonly string[]): JevBuild {
  const items = [...new Set(labels.map((l) => l.trim()).filter((l) => l !== ""))].slice(0, MAX_OPTIONS);
  const spans = labelSpans(utterance);

  const questions: Record<string, JevQuestion> = {
    intent: {
      type: "choice",
      instructions: "What is the speaker asking the diagram editor to do?",
      criteria: { ...INTENTS },
    },
    shape_stated: {
      type: "noul",
      instructions: "Do the speaker's words point at a particular kind of shape?",
      criteria: {
        true: "they name a shape outright — a box, a circle, a diamond — or they name the thing a shape stands for, like a decision, a database, a document, a start or an end. Naming the role counts just as much as naming the geometry.",
        false: "they ask for something generic — “a thing”, “a box for this” — or say nothing that implies a shape",
      },
    },
    shape: {
      type: "choice",
      instructions: "Which kind of shape is the speaker asking for?",
      criteria: { ...SHAPE_HINTS },
    },
    color_stated: {
      type: "noul",
      instructions: "Does the speaker say anything at all about colour?",
      criteria: {
        true: "they name a colour, or ask for the colour to be cleared or made plain",
        false: "colour is not mentioned",
      },
    },
    color: {
      type: "choice",
      instructions: "Which colour is the speaker asking for?",
      criteria: { ...COLOR_HINTS },
    },
    direction: {
      type: "choice",
      instructions: "Which way does the speaker want the thing shifted?",
      criteria: { ...DIRECTIONS },
    },
    arrowhead: {
      type: "noul",
      instructions: "Should the new connector have an arrowhead on the end?",
      criteria: {
        true: "they ask for an arrow, or say nothing either way — an arrow is the ordinary case",
        false: "they explicitly ask for a plain line, with no arrowhead",
      },
    },
    label_span: {
      type: "choice",
      instructions:
        "Which run of words from `utterance` is the text the speaker wants written on the shape? Pick the words that would go on it, not the words that introduce them.",
      criteria: {
        ...Object.fromEntries(spans.map((s) => [s, `the words “${s}”`])),
        [NO_SPAN]: "the speaker does not say what the shape should be labelled",
      },
    },
  };

  // Only ask about existing items when there are some to point at: a choice
  // whose only option is the escape hatch teaches the model nothing.
  if (items.length > 0) {
    const described = describeItems(items);
    // Presence and identity are asked apart on purpose. Folded into one choice,
    // "the selected one" and the name of the only item on the canvas are not
    // competing answers — they are the same outcome worded twice, and the model
    // splitting evenly between them reads as doubt when nothing is in doubt.
    questions.target_named = {
      type: "noul",
      instructions:
        "Do the speaker's words single out one of the items in `existing_items`, rather than just pointing vaguely at something?",
      criteria: {
        true: "their words pick one out — by its name, or by describing what it is or does, like “the storage thing”, “the queue”, “the one we started with”. An approximate description still counts, so long as it fits one item better than the rest.",
        false:
          "they only point — “it”, “that”, “this one”, “the thing” — or mention no item at all, leaving whatever is already selected",
      },
    };
    questions.target = {
      type: "choice",
      instructions:
        "The speaker is talking about one of the items on the canvas. Which one do their words pick out?",
      criteria: { ...described },
    };
    if (items.length > 1) {
      // Two roles drawn from the same pool, so each question says which role.
      questions.connect_from = {
        type: "choice",
        instructions: "Which item should the connector start from? This is the source, the one named first.",
        criteria: { ...described },
      };
      questions.connect_to = {
        type: "choice",
        instructions: "Which item should the connector point at? This is the destination, the one named second.",
        criteria: { ...described },
      };
    }
  }

  return { state: { utterance, existing_items: items }, questions, spans };
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/**
 * How sure the command has to be before it runs, as the *minimum* over the
 * judgements it rests on — one wrong part spoils the command, but a command
 * with more parts is not inherently shakier, so a product would be wrong.
 *
 * Only judgements that change *what happens* are counted. Shape and colour are
 * harmless preferences with an obvious default and a one-key undo; letting a
 * 0.5 between "blue" and "purple" veto the whole command would be silly.
 *
 * These are starting points. They want tuning against real utterances.
 */
export const MIN_CONFIDENCE = 0.55;
/** Anything that destroys work has to clear a higher bar. */
export const DESTRUCTIVE_CONFIDENCE = 0.8;
const DESTRUCTIVE: ReadonlySet<string> = new Set(["delete", "clear"]);
/** A noul this near 0.5 is a coin flip, and a coin flip is not a yes. */
const NOUL_YES = 0.6;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

interface Judgement {
  value: string;
  confidence: number;
}

/** A choice answer as (option, confidence), or null if it is unreadable. */
function readChoice(answers: Record<string, unknown>, id: string): Judgement | null {
  const a = answers[id];
  if (!isRecord(a) || typeof a.choice !== "string") return null;
  const c = typeof a.confidence === "number" && Number.isFinite(a.confidence) ? a.confidence : 0;
  return { value: a.choice, confidence: Math.max(0, Math.min(1, c)) };
}

/**
 * A noul answer as yes/no plus a confidence. Jev attaches no confidence to a
 * noul — it is a probability — so derive one: 0.5 is a dead heat between yes
 * and no, and both ends are certain. (Near 0.5 means "evenly split", *not*
 * "medium intensity".)
 */
function readNoul(answers: Record<string, unknown>, id: string): { yes: boolean; confidence: number } | null {
  const a = answers[id];
  if (!isRecord(a) || typeof a.noul !== "number" || !Number.isFinite(a.noul)) return null;
  const p = Math.max(0, Math.min(1, a.noul));
  return { yes: p >= NOUL_YES, confidence: Math.abs(p - 0.5) * 2 };
}

export interface Decoded {
  ops: VoiceOp[];
  /** The weakest judgement the command rests on. 0 when nothing was decided. */
  confidence: number;
  intent: string;
}

/**
 * Turn a batch of typed answers into ops. Yields no ops — rather than a guess
 * — when the intent is `none`, when a part the op cannot do without is missing
 * or ungrounded, or when the weakest load-bearing judgement misses the bar.
 */
export function decode(raw: unknown, utterance: string, spans: readonly string[]): Decoded {
  const none = (intent = "none", confidence = 0): Decoded => ({ ops: [], confidence, intent });
  if (!isRecord(raw)) return none();
  const answers = isRecord(raw.answers) ? raw.answers : raw;

  const intent = readChoice(answers, "intent");
  if (intent === null || intent.value === "none") return none(intent?.value ?? "none");

  /** Load-bearing judgements only — see MIN_CONFIDENCE. */
  const critical: number[] = [intent.confidence];

  /** The named item, or undefined meaning "whatever is selected". */
  const target = (): string | undefined => {
    // Did they name one at all? If not, the identity answer is an unused
    // branch and its uncertainty is beside the point.
    const named = readNoul(answers, "target_named");
    if (named === null || !named.yes) return undefined;
    const t = readChoice(answers, "target");
    if (t === null) return undefined;
    // Both halves count: acting on the wrong item is how a command does damage.
    critical.push(named.confidence, t.confidence);
    return t.value;
  };

  const spanLabel = (): string | undefined => {
    const s = readChoice(answers, "label_span");
    if (s === null || s.value === NO_SPAN || !spans.includes(s.value)) return undefined;
    critical.push(s.confidence);
    // Spans are lowercased for matching; recover the casing as spoken, so an
    // "API gateway" comes back as "API Gateway" rather than "Api Gateway".
    return presentLabel(s.value, utterance);
  };

  let ops: VoiceOp[];
  switch (intent.value) {
    case "add": {
      let shape: NodeType = "rect";
      if (readNoul(answers, "shape_stated")?.yes === true) {
        const picked = readChoice(answers, "shape");
        if (picked !== null && (NODE_TYPES as readonly string[]).includes(picked.value)) {
          shape = picked.value as NodeType;
        }
      }
      const label = spanLabel();
      ops = [{ op: "add", shape, ...(label !== undefined ? { label } : {}) }];
      break;
    }
    case "connect": {
      const from = readChoice(answers, "connect_from");
      const to = readChoice(answers, "connect_to");
      // Jev can only pick from what exists; it cannot invent an endpoint. A
      // connect it cannot ground in two distinct items is simply not made.
      if (from === null || to === null || from.value === to.value) return none(intent.value);
      critical.push(from.confidence, to.confidence);
      const arrow = readNoul(answers, "arrowhead");
      ops = [
        { op: "connect", chain: [from.value, to.value], ...(arrow !== null ? { arrow: arrow.yes } : {}) },
      ];
      break;
    }
    case "rename": {
      const label = spanLabel();
      if (label === undefined) return none(intent.value);
      const t = target();
      ops = [{ op: "rename", label, ...(t !== undefined ? { target: t } : {}) }];
      break;
    }
    case "fill": {
      if (readNoul(answers, "color_stated")?.yes !== true) return none(intent.value);
      const picked = readChoice(answers, "color");
      if (picked === null || !(picked.value in SWATCH)) return none(intent.value);
      const t = target();
      ops = [
        { op: "fill", color: SWATCH[picked.value as SwatchName], ...(t !== undefined ? { target: t } : {}) },
      ];
      break;
    }
    case "delete":
    case "duplicate": {
      const t = target();
      ops = [{ op: intent.value, ...(t !== undefined ? { target: t } : {}) }];
      break;
    }
    case "select": {
      const t = target();
      // "select whatever is already selected" is not worth a round trip.
      if (t === undefined) return none(intent.value);
      ops = [{ op: "select", target: t }];
      break;
    }
    case "move": {
      const dir = readChoice(answers, "direction");
      const delta: Readonly<Record<string, { dx: number; dy: number }>> = {
        left: { dx: -MOVE_STEP, dy: 0 },
        right: { dx: MOVE_STEP, dy: 0 },
        up: { dx: 0, dy: -MOVE_STEP },
        down: { dx: 0, dy: MOVE_STEP },
      };
      const d = dir === null ? undefined : delta[dir.value];
      if (d === undefined) return none(intent.value);
      const t = target();
      ops = [{ op: "move", dx: d.dx, dy: d.dy, ...(t !== undefined ? { target: t } : {}) }];
      break;
    }
    case "tidy":
      ops = [{ op: "tidy" }];
      break;
    case "undo":
      ops = [{ op: "history", action: "undo" }];
      break;
    case "redo":
      ops = [{ op: "history", action: "redo" }];
      break;
    case "clear":
      ops = [{ op: "canvas", action: "clear" }];
      break;
    case "sample":
      ops = [{ op: "canvas", action: "sample" }];
      break;
    case "export_svg":
      ops = [{ op: "export", format: "svg" }];
      break;
    case "export_png":
      ops = [{ op: "export", format: "png" }];
      break;
    case "save":
      ops = [{ op: "file", action: "save" }];
      break;
    case "open":
      ops = [{ op: "file", action: "open" }];
      break;
    case "theme_dark":
      ops = [{ op: "theme", theme: "dark" }];
      break;
    case "theme_light":
      ops = [{ op: "theme", theme: "light" }];
      break;
    case "zoom_in":
      ops = [{ op: "zoom", dir: "in" }];
      break;
    case "zoom_out":
      ops = [{ op: "zoom", dir: "out" }];
      break;
    case "zoom_reset":
      ops = [{ op: "zoom", dir: "reset" }];
      break;
    case "mode_draw":
      ops = [{ op: "mode", mode: "draw" }];
      break;
    case "mode_select":
      ops = [{ op: "mode", mode: "select" }];
      break;
    case "mode_text":
      ops = [{ op: "mode", mode: "text" }];
      break;
    case "mode_write":
      ops = [{ op: "mode", mode: "write" }];
      break;
    case "arrows_on":
      ops = [{ op: "arrows", on: true }];
      break;
    case "arrows_off":
      ops = [{ op: "arrows", on: false }];
      break;
    case "help":
      ops = [{ op: "help" }];
      break;
    default:
      return none(intent.value);
  }

  const confidence = Math.min(...critical);
  const bar = DESTRUCTIVE.has(intent.value) ? DESTRUCTIVE_CONFIDENCE : MIN_CONFIDENCE;
  return confidence < bar ? none(intent.value, confidence) : { ops, confidence, intent: intent.value };
}
