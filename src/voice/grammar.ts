import type { NodeType } from "../types";
import type { VoiceOp } from "./ops";

/**
 * The offline command grammar: spoken (or typed) English → `VoiceOp[]`.
 *
 * Pure, deterministic, dependency-free, and unit-tested. It is the *primary*
 * parser, not a fallback — everyday diagramming phrases resolve here with no
 * key, no network, and no latency. The optional LLM route (`/api/voice`) only
 * sees an utterance this file declines to parse.
 *
 * Structure: an utterance is split into clauses on unambiguous separators,
 * then each clause is matched against an ordered rule list, first match wins.
 * Rules that share a verb with another rule ("draw a line from…" vs "draw a
 * box") are ordered so the more specific one is tried first.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Shape synonyms, including the flowchart role names people actually say.
 * Plural forms are generated, so only singulars are listed.
 */
const SHAPE_SYNONYMS: ReadonlyArray<readonly [string, NodeType]> = [
  ["text box", "text"],
  ["textbox", "text"],
  ["text", "text"],
  ["label", "text"],
  ["note", "text"],
  ["caption", "text"],

  ["rectangle", "rect"],
  ["rect", "rect"],
  ["box", "rect"],
  ["square", "rect"],
  ["block", "rect"],
  ["step", "rect"],
  ["process", "rect"],
  ["node", "rect"],
  ["task", "rect"],

  ["ellipse", "ellipse"],
  ["circle", "ellipse"],
  ["oval", "ellipse"],
  ["bubble", "ellipse"],
  ["terminator", "ellipse"],

  ["diamond", "diamond"],
  ["decision", "diamond"],
  ["condition", "diamond"],
  ["conditional", "diamond"],
  ["rhombus", "diamond"],
  ["choice", "diamond"],
  ["branch", "diamond"],
  ["gate", "diamond"],

  ["triangle", "triangle"],

  ["hexagon", "hexagon"],
  ["hex", "hexagon"],
  ["preparation", "hexagon"],

  ["parallelogram", "parallelogram"],
  ["input output", "parallelogram"],
  ["input", "parallelogram"],
  ["output", "parallelogram"],

  ["cylinder", "cylinder"],
  ["database", "cylinder"],
  ["data store", "cylinder"],
  ["datastore", "cylinder"],
  ["storage", "cylinder"],
  ["disk", "cylinder"],
];

function pluralize(word: string): string {
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

/** Shape phrases keyed by word count, longest phrase wins at a given position. */
const SHAPE_LOOKUP: ReadonlyMap<string, NodeType> = (() => {
  const m = new Map<string, NodeType>();
  for (const [word, type] of SHAPE_SYNONYMS) {
    if (!m.has(word)) m.set(word, type);
    const plural = word.split(" ").length === 1 ? pluralize(word) : `${word}s`;
    if (!m.has(plural)) m.set(plural, type);
  }
  return m;
})();

const MAX_SHAPE_WORDS = 2;

/**
 * Resolve a bare noun to a shape, e.g. "circle" → "ellipse". Used by the
 * planner so "delete the database" can fall back to "the most recent
 * cylinder" when no node is actually labelled "database".
 */
export function shapeFromWord(word: string): NodeType | null {
  return SHAPE_LOOKUP.get(word.trim().toLowerCase().replace(/^the\s+/, "")) ?? null;
}

/**
 * Fill colors, mapped to the canvas swatch palette. These hexes mirror
 * `FILL_SWATCHES` in `components/Canvas.tsx`; "" is the auto/theme fill.
 * (Kept as literals so this module stays free of any React import and can run
 * in the node test environment.)
 */
export const SWATCH = {
  blue: "#eef2fb",
  green: "#e8f1ec",
  orange: "#fdf2e7",
  pink: "#f7ebee",
  purple: "#eeeaf6",
  grey: "#f0f0ee",
  auto: "",
} as const;

export type SwatchName = keyof typeof SWATCH;

/** Spoken colour words, each folded onto one of the swatches above. */
const COLORS: Readonly<Record<string, string>> = {
  blue: SWATCH.blue,
  navy: SWATCH.blue,
  cyan: SWATCH.blue,
  sky: SWATCH.blue,
  green: SWATCH.green,
  mint: SWATCH.green,
  teal: SWATCH.green,
  emerald: SWATCH.green,
  orange: SWATCH.orange,
  amber: SWATCH.orange,
  yellow: SWATCH.orange,
  gold: SWATCH.orange,
  tan: SWATCH.orange,
  peach: SWATCH.orange,
  pink: SWATCH.pink,
  red: SWATCH.pink,
  rose: SWATCH.pink,
  magenta: SWATCH.pink,
  crimson: SWATCH.pink,
  purple: SWATCH.purple,
  violet: SWATCH.purple,
  lavender: SWATCH.purple,
  indigo: SWATCH.purple,
  lilac: SWATCH.purple,
  grey: SWATCH.grey,
  gray: SWATCH.grey,
  silver: SWATCH.grey,
  stone: SWATCH.grey,
  white: SWATCH.auto,
  blank: SWATCH.auto,
  none: SWATCH.auto,
  auto: SWATCH.auto,
  automatic: SWATCH.auto,
  default: SWATCH.auto,
  transparent: "",
};

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

/** Words that mark the start of a label: "a box **called** signal". */
const NAMING_KEYWORDS = [
  "called",
  "named",
  "labeled",
  "labelled",
  "titled",
  "saying",
  "that says",
  "which says",
  "that reads",
  "reading",
  "marked",
  "with the label",
  "with label",
  "for",
];

/** Pronouns that mean "whatever is selected right now". */
const PRONOUNS: ReadonlySet<string> = new Set([
  "it",
  "that",
  "this",
  "them",
  "those",
  "these",
  "selection",
  "the selection",
  "selected",
  "the selected one",
  "the current one",
  "current",
  "the node",
  "the shape",
  "the edge",
  "the arrow",
  "the line",
  "the connector",
  "the last one",
  "the new one",
]);

/** A label that begins with one of these is really a trailing phrase, not a name. */
const POSITIONAL_LEADERS: ReadonlySet<string> = new Set([
  "to",
  "at",
  "on",
  "in",
  "into",
  "near",
  "next",
  "under",
  "underneath",
  "above",
  "below",
  "beside",
  "between",
  "from",
  "with",
  "and",
  "then",
  "that",
  "which",
  "here",
  "there",
  "over",
  "beneath",
  "please",
  "instead",
]);

/** Chain separators inside a connect clause. */
const CHAIN_SPLIT = /\s+(?:to|and|into|with|toward|towards|through|then)\s+|\s*(?:->|-->|→|,)\s*/;

/** Default nudge distance, in scene units, when a move says no amount. */
export const MOVE_STEP = 40;

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/** Lowercase, drop filler punctuation, collapse whitespace. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/[!?.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip wake words and politeness so "hey plexus, please add a box" parses. */
function stripPreamble(s: string): string {
  let out = s;
  let changed = true;
  while (changed) {
    const before = out;
    out = out
      .replace(/^(?:hey|ok|okay|yo|hi)\s+plexus\b/, "")
      .replace(/^plexus\b/, "")
      .replace(/^(?:please|can you|could you|would you|i want to|i want you to|i need|lets|let us|now)\b/, "")
      .replace(/^(?:go ahead and)\b/, "")
      .trim();
    changed = out !== before;
  }
  return out;
}

/**
 * Split an utterance into independent command clauses on separators that are
 * never part of a single command. Bare "and" is deliberately NOT a separator —
 * "connect a and b" is one command.
 */
export function splitClauses(text: string): string[] {
  return text
    .split(/[;.!?\n]+|\s*,?\s*(?:and\s+then|then|after that|next up|also)\s+/i)
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

function words(s: string): string[] {
  return s === "" ? [] : s.split(" ");
}

/** Parse a count/amount: digits, a number word, or "twenty five". */
export function parseNumber(s: string): number | null {
  const t = s.trim().replace(/-/g, " ");
  if (t === "") return null;
  if (/^\d+$/.test(t)) return Number(t);
  const parts = words(t);
  let total = 0;
  let matched = false;
  for (const p of parts) {
    const n = /^\d+$/.test(p) ? Number(p) : NUMBER_WORDS[p];
    if (n === undefined) return matched ? total : null;
    total += n;
    matched = true;
  }
  return matched ? total : null;
}

/** Longest shape phrase starting at word `i`, or null. */
function matchShapeAt(ws: readonly string[], i: number): { type: NodeType; len: number } | null {
  for (let len = Math.min(MAX_SHAPE_WORDS, ws.length - i); len >= 1; len--) {
    const phrase = ws.slice(i, i + len).join(" ");
    const type = SHAPE_LOOKUP.get(phrase);
    if (type) return { type, len };
  }
  return null;
}

function stripArticles(s: string): string {
  return s.replace(/^(?:the|a|an|my|our|another|some|that|this)\s+/, "").trim();
}

/**
 * Turn a spoken target phrase into a `target` field: `undefined` means "the
 * current selection", anything else is a name to resolve against node labels.
 */
function toTarget(phrase: string): string | undefined {
  const t = phrase.trim();
  if (t === "" || PRONOUNS.has(t)) return undefined;
  const stripped = stripArticles(t);
  if (stripped === "" || PRONOUNS.has(stripped)) return undefined;
  return stripped;
}

/** Split off a trailing `called X` / `labeled X` clause. */
function splitNaming(s: string): { head: string; label: string | null } {
  let best: { head: string; label: string } | null = null;
  for (const kw of NAMING_KEYWORDS) {
    const needle = ` ${kw} `;
    const idx = s.lastIndexOf(needle);
    if (idx === -1) continue;
    const head = s.slice(0, idx).trim();
    const label = s.slice(idx + needle.length).trim();
    if (label === "") continue;
    // Prefer the *latest* keyword so "a box called a called b" names it "b".
    if (!best || head.length > best.head.length) best = { head, label };
  }
  return best ? { head: best.head, label: best.label } : { head: s, label: null };
}

/** Split off a trailing `near X` / `next to X` clause. */
function splitNear(s: string): { head: string; near: string | null } {
  const m = /^(.*?)\s+(?:near|next to|beside|by|under|below|above|over|right of|left of)\s+(.+)$/.exec(s);
  if (!m || m[1] === undefined || m[2] === undefined) return { head: s, near: null };
  return { head: m[1].trim(), near: m[2].trim() };
}

/**
 * Restore the casing the speaker implied for a label. Speech recognizers
 * lowercase everything, and an all-lowercase label looks wrong in a diagram —
 * so single words and short phrases are title-cased, and an existing acronym
 * in the raw text is preserved.
 */
export function titleCase(s: string): string {
  return s.trim().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function presentLabel(raw: string, originalText: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  // If the un-normalized utterance contained this run with capitals, keep them.
  const idx = originalText.toLowerCase().indexOf(trimmed);
  if (idx !== -1) {
    const asTyped = originalText.slice(idx, idx + trimmed.length);
    if (asTyped.toLowerCase() === trimmed && /[A-Z]/.test(asTyped)) return asTyped;
  }
  return titleCase(trimmed);
}

// ---------------------------------------------------------------------------
// Clause rules
// ---------------------------------------------------------------------------

/** Verb groups, as alternation fragments. */
const V_ADD = "add|create|make|new|insert|put|place|draw|drop|give me|start with|begin with";
const V_CONNECT = "connect|link|join|attach|wire up|wire|hook up|hook|route|point";
const V_DELETE = "delete|remove|erase|get rid of|rid of|drop|kill|trash";
const V_SELECT = "select|pick|choose|highlight|grab|focus on|focus|go to|jump to";
const V_MOVE = "move|nudge|push|shift|slide|bump";
const V_RENAME = "rename|retitle|relabel|call|label|name|title";

type Rule = (clause: string, original: string) => VoiceOp[] | null;

/** Whole-utterance app commands. Checked first: they are short and exact. */
const appRules: ReadonlyArray<readonly [RegExp, VoiceOp[]]> = [
  [/^(?:undo|undo that|go back|take that back|oops|never ?mind)$/, [{ op: "history", action: "undo" }]],
  [/^(?:redo|redo that|do it again|put it back)$/, [{ op: "history", action: "redo" }]],
  [
    /^(?:clear|reset|wipe)(?: the)?(?: canvas| diagram| board| everything| all)?$|^start over$|^new (?:diagram|canvas|sheet|page)$|^delete everything$/,
    [{ op: "canvas", action: "clear" }],
  ],
  [
    /^(?:load |show (?:me )?|open )?(?:the )?(?:sample|demo|example)(?: pathway| diagram)?$/,
    [{ op: "canvas", action: "sample" }],
  ],
  [/^(?:export|download|give me)?\s*(?:as |an |a |to )*svg$|^export (?:as |to )?(?:an? )?svg$|^save (?:as |to )?svg$/, [{ op: "export", format: "svg" }]],
  [
    /^(?:export|download|give me)?\s*(?:as |an |a |to )*(?:png|image|picture)$|^export (?:as |to )?(?:an? )?(?:png|image)$|^save (?:as |to )?(?:png|image)$|^screenshot$/,
    [{ op: "export", format: "png" }],
  ],
  [/^save(?: the)?(?: diagram| file| it| this| my work)?$|^download(?: the)? json$/, [{ op: "file", action: "save" }]],
  [/^open(?: a| the)?(?: saved)?(?: diagram| file| json)?$|^load(?: a| the)?(?: saved)? (?:diagram|file|json)$/, [{ op: "file", action: "open" }]],
  [/^(?:go )?dark(?: mode| theme)?$|^dark$|^night mode$|^lights out$|^switch to dark(?: mode| theme)?$/, [{ op: "theme", theme: "dark" }]],
  [/^(?:go )?light(?: mode| theme)?$|^light$|^day mode$|^lights on$|^switch to light(?: mode| theme)?$/, [{ op: "theme", theme: "light" }]],
  [/^zoom in$|^closer$|^bigger$|^magnify$/, [{ op: "zoom", dir: "in" }]],
  [/^zoom out$|^further(?: out)?$|^smaller$|^back out$/, [{ op: "zoom", dir: "out" }]],
  [
    /^(?:reset|fit)(?: the)? (?:zoom|view)$|^zoom (?:reset|normal|to (?:100|one hundred) percent)$|^actual size$|^(?:100|one hundred) percent$/,
    [{ op: "zoom", dir: "reset" }],
  ],
  [/^(?:draw|drawing|sketch|sketching|pen)(?: mode)?$|^(?:start|let me) draw(?:ing)?$/, [{ op: "mode", mode: "draw" }]],
  [/^(?:select|selection|pointer|cursor|move|arrange)(?: mode)$/, [{ op: "mode", mode: "select" }]],
  [/^(?:write|writing|handwriting|handwrite)(?: mode)?$/, [{ op: "mode", mode: "write" }]],
  [/^text mode$|^(?:the )?text tool$/, [{ op: "mode", mode: "text" }]],
  [/^(?:use |turn on |enable |switch to )?arrow(?:head)?s(?: on)?$|^arrows please$/, [{ op: "arrows", on: true }]],
  [
    /^(?:use |turn off |disable |switch to )?(?:plain )?lines?(?: only)?$|^no arrow(?:head)?s$|^arrow(?:head)?s off$/,
    [{ op: "arrows", on: false }],
  ],
  [
    /^(?:tidy|tidy up|clean up|clean it up|arrange|arrange (?:it|this|everything)|auto ?layout|lay (?:it|this) out|organi[sz]e(?: (?:it|this))?|straighten (?:it|this) (?:up|out))$/,
    [{ op: "tidy" }],
  ],
  [
    /^(?:help|what can i say|what can you do|commands|shortcuts|show (?:me )?(?:the )?(?:shortcuts|commands|help))$/,
    [{ op: "help" }],
  ],
];

/** `connect a to b labeled yes` — tried before create so "draw a line" wins. */
const connectRule: Rule = (clause, original) => {
  const explicit = new RegExp(`^(?:${V_CONNECT})\\b\\s*(.*)$`).exec(clause);
  const drawn = new RegExp(
    `^(?:${V_ADD})\\s+(?:a|an|the)?\\s*(arrow|line|edge|connector|connection|link)\\b\\s*(.*)$`,
  ).exec(clause);
  const bare = /^(?:arrow|line|edge|connector)\s+(?:from\s+)?(.+\s+to\s+.+)$/.exec(clause);

  let rest: string;
  let arrow: boolean | undefined;
  if (explicit?.[1] !== undefined) {
    rest = explicit[1];
    if (/\barrow\b/.test(clause)) arrow = true;
    else if (/\b(?:plain )?line\b/.test(clause)) arrow = false;
  } else if (drawn?.[1] !== undefined && drawn[2] !== undefined) {
    rest = drawn[2];
    arrow = drawn[1] !== "line";
  } else if (bare?.[1] !== undefined) {
    rest = bare[1];
    arrow = /^arrow/.test(clause);
  } else {
    return null;
  }

  rest = rest.replace(/^(?:a|an|the)\s+(?:arrow|line|edge|connector|connection)\s*/, "").trim();
  rest = rest.replace(/^from\s+/, "").trim();
  if (rest === "") return null;

  const { head, label } = splitNaming(rest);
  const chain = head
    .split(CHAIN_SPLIT)
    .map((p) => stripArticles(p.trim()))
    .filter((p) => p !== "");
  if (chain.length < 2) return null;

  return [
    {
      op: "connect",
      chain,
      ...(label !== null ? { label: presentLabel(label, original) } : {}),
      ...(arrow !== undefined ? { arrow } : {}),
    },
  ];
};

/** `add three blue boxes called signal near prep` */
const createRule: Rule = (clause, original) => {
  const m = new RegExp(`^(?:${V_ADD})\\b\\s*(.*)$`).exec(clause);
  if (m?.[1] === undefined) return null;
  let rest = m[1].trim();
  if (rest === "") return null;
  // "make it blue" shares a verb with "make a box" but is a fill, not a create.
  if (/^(?:it|that|this|them|these|those|everything|the selection)\b/.test(rest)) return null;

  // Trailing "near X" is placement, not part of the name.
  const nearSplit = splitNear(rest);
  let near: string | null = null;
  if (nearSplit.near !== null) {
    // Only treat it as placement when the head still describes something to add.
    rest = nearSplit.head;
    near = stripArticles(nearSplit.near);
  }

  const naming = splitNaming(rest);
  const hasNamingKeyword = naming.label !== null;
  let head = naming.head;
  let labelText = naming.label ?? "";

  let ws = words(head);
  let i = 0;

  // Optional count: "add three boxes".
  let count = 1;
  if (ws[0] !== undefined) {
    const n = parseNumber(ws[0]);
    // "a"/"an" are articles here, not a count worth reporting.
    if (n !== null && n >= 1 && n <= 12 && ws[0] !== "a" && ws[0] !== "an") {
      count = n;
      i = 1;
    }
  }

  // Optional article.
  while (ws[i] !== undefined && /^(?:a|an|the|another|some|one|new)$/.test(ws[i]!)) i++;

  // Optional fill color: "add a blue box".
  let color: string | undefined;
  if (ws[i] !== undefined && Object.prototype.hasOwnProperty.call(COLORS, ws[i]!)) {
    const candidate = COLORS[ws[i]!]!;
    // Only consume it as a color when a shape word follows; otherwise it is a name.
    if (matchShapeAt(ws, i + 1)) {
      color = candidate;
      i++;
    }
  }

  // Optional shape word; default to a rectangle.
  let shape: NodeType = "rect";
  const shapeHit = matchShapeAt(ws, i);
  if (shapeHit) {
    shape = shapeHit.type;
    i += shapeHit.len;
  }

  // Whatever is left of the head is an unmarked label ("add a box signal").
  const tail = ws.slice(i).join(" ").trim();
  if (!hasNamingKeyword && tail !== "") {
    const firstWord = words(tail)[0];
    if (firstWord !== undefined && POSITIONAL_LEADERS.has(firstWord)) return null;
    labelText = tail;
  } else if (hasNamingKeyword && tail !== "") {
    // Words between the shape and the naming keyword are noise ("box that is").
    ws = words(tail);
  }

  if (!shapeHit && labelText === "" && count === 1) return null; // "add" alone is not a command

  const label = labelText === "" ? null : presentLabel(labelText, original);

  const ops: VoiceOp[] = [];
  for (let k = 0; k < count; k++) {
    ops.push({
      op: "add",
      shape,
      ...(label !== null ? { label: count > 1 ? `${label} ${k + 1}` : label } : {}),
      ...(near !== null ? { near } : {}),
    });
  }
  if (color !== undefined) {
    // The color applies to what was just added; the planner reads an omitted
    // target as "the thing this utterance most recently touched".
    for (let k = 0; k < count; k++) ops.push({ op: "fill", color });
  }
  return ops;
};

/** `fill it blue`, `make store orange`, `color the gate green` */
const fillRule: Rule = (clause) => {
  const m = /^(?:fill|colou?r|paint|shade|make|turn)\s+(.*)$/.exec(clause);
  if (m?.[1] === undefined) return null;
  const rest = m[1].trim();
  const ws = words(rest);
  const lastWord = ws[ws.length - 1];
  if (lastWord === undefined) return null;
  if (!Object.prototype.hasOwnProperty.call(COLORS, lastWord)) return null;
  const color = COLORS[lastWord]!;
  const targetPhrase = ws
    .slice(0, -1)
    .join(" ")
    .replace(/\s+(?:in|with|to|as)$/, "")
    .trim();
  return [{ op: "fill", color, ...(toTarget(targetPhrase) !== undefined ? { target: toTarget(targetPhrase)! } : {}) }];
};

/** `rename signal to input`, `call it KINASE`, `label yes` */
const renameRule: Rule = (clause, original) => {
  const m = new RegExp(`^(?:${V_RENAME})\\b\\s+(.*)$`).exec(clause);
  if (m?.[1] === undefined) return null;
  const verb = /^(\w+)/.exec(clause)?.[1] ?? "";
  let rest = m[1].trim();
  if (rest === "") return null;

  // "rename it to X" / "call that X"
  const pronounLead = /^(it|that|this|the selection|selection|the selected one|the node|the shape|the edge|the arrow|the line|the connector)\b\s*(.*)$/.exec(
    rest,
  );
  if (pronounLead?.[2] !== undefined) {
    const label = pronounLead[2].replace(/^to\s+/, "").trim();
    if (label === "") return null;
    return [{ op: "rename", label: presentLabel(label, original) }];
  }

  const toSplit = /^(.*?)\s+to\s+(.+)$/.exec(rest);
  if (toSplit?.[1] !== undefined && toSplit[2] !== undefined) {
    const target = toTarget(toSplit[1]);
    return [
      {
        op: "rename",
        label: presentLabel(toSplit[2], original),
        ...(target !== undefined ? { target } : {}),
      },
    ];
  }

  // "rename" without a new name is meaningless; "label yes" names the selection.
  if (verb === "rename" || verb === "retitle" || verb === "relabel") return null;
  rest = rest.replace(/^(?:the\s+)?(?:edge|arrow|line|connector|node|shape)\s+/, "").trim();
  if (rest === "") return null;
  return [{ op: "rename", label: presentLabel(rest, original) }];
};

const deleteRule: Rule = (clause) => {
  const m = new RegExp(`^(?:${V_DELETE})\\b\\s*(.*)$`).exec(clause);
  if (m?.[1] === undefined) return null;
  const target = toTarget(m[1]);
  return [{ op: "delete", ...(target !== undefined ? { target } : {}) }];
};

const selectRule: Rule = (clause) => {
  const m = new RegExp(`^(?:${V_SELECT})\\b\\s+(.*)$`).exec(clause);
  if (m?.[1] === undefined) return null;
  const target = toTarget(m[1]);
  if (target === undefined) return null; // "select it" is a no-op
  return [{ op: "select", target }];
};

const duplicateRule: Rule = (clause) => {
  const m = /^(?:duplicate|clone|copy)\b\s*(.*)$/.exec(clause);
  if (m?.[1] === undefined) return null;
  const target = toTarget(m[1]);
  return [{ op: "duplicate", ...(target !== undefined ? { target } : {}) }];
};

const moveRule: Rule = (clause) => {
  const m = new RegExp(
    `^(?:${V_MOVE})\\b\\s*(.*?)\\s*\\b(left|right|up|down)\\b(?:\\s+(?:by\\s+)?(.+))?$`,
  ).exec(clause);
  if (m?.[2] === undefined) return null;
  const amountText = (m[3] ?? "").replace(/\b(?:pixels?|px|units?|a bit|a little|some)\b/g, "").trim();
  const parsed = amountText === "" ? null : parseNumber(amountText);
  const step = parsed !== null && parsed > 0 ? Math.min(2000, parsed) : MOVE_STEP;
  const dir = m[2];
  const dx = dir === "left" ? -step : dir === "right" ? step : 0;
  const dy = dir === "up" ? -step : dir === "down" ? step : 0;
  const target = toTarget(m[1] ?? "");
  return [{ op: "move", dx, dy, ...(target !== undefined ? { target } : {}) }];
};

/** Ordered: more specific verbs first where two rules share a verb. */
const RULES: readonly Rule[] = [
  connectRule, // before create: "draw a line from a to b"
  createRule,
  fillRule, // after create: "make a box" is a create, "make it blue" is a fill
  renameRule,
  duplicateRule,
  deleteRule,
  selectRule,
  moveRule,
];

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Parse one clause. Returns null when no rule matches. */
export function parseClause(clause: string, original = clause): VoiceOp[] | null {
  const c = stripPreamble(normalize(clause));
  if (c === "") return null;

  for (const [re, ops] of appRules) {
    if (re.test(c)) return ops.map((o) => ({ ...o }));
  }
  for (const rule of RULES) {
    const ops = rule(c, original);
    if (ops && ops.length > 0) return ops;
  }
  return null;
}

export interface ParseResult {
  ops: VoiceOp[];
  /** Clauses no rule understood — what the LLM tier, if configured, retries. */
  unparsed: string[];
}

/**
 * Parse a whole utterance into ops, reporting the clauses that failed so the
 * caller can escalate just those to the remote parser.
 */
export function parseUtterance(text: string): ParseResult {
  const ops: VoiceOp[] = [];
  const unparsed: string[] = [];
  for (const clause of splitClauses(text)) {
    const parsed = parseClause(clause, text);
    if (parsed) ops.push(...parsed);
    else unparsed.push(clause);
  }
  return { ops, unparsed };
}

/** Example phrases, shown in the UI and in the remote parser's prompt. */
export const EXAMPLE_PHRASES: readonly string[] = [
  "add a box called Signal",
  "add a decision called Pass",
  "connect Signal to Pass",
  "arrow from Pass to Render labeled yes",
  "add a database called Store",
  "make it blue",
  "rename Store to Archive",
  "tidy up",
  "export SVG",
  "dark mode",
  "undo",
];
