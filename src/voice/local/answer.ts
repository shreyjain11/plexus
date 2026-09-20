/**
 * The free tier: answer the same questions Jev answers, in the browser, with
 * no key and no network.
 *
 * The reason this is possible at all is the shape of the hosted tier. Every
 * question `buildRequest` asks is "pick one of these", so nothing here has to
 * generate anything — it only has to rank. That splits cleanly in two:
 *
 *   semantic  — which of 30 intents, and which node on the canvas they meant.
 *               A sentence-embedding model does this well and a lexicon cannot,
 *               because "it's too bright in here" shares no word with "dark".
 *   lexical   — shape, colour, direction, arrowheads, and which run of words is
 *               a label. Tier 1 already owns exact vocabularies for these (46
 *               shape synonyms, ~30 colour words), and an exact table beats a
 *               similarity score every time. No reason to ask a model.
 *
 * Output is deliberately Jev's wire shape, so `decode()` — with all its
 * grounding checks and confidence gates — is reused verbatim rather than
 * reimplemented. The two tiers cannot drift apart, because there is only one
 * decoder.
 *
 * This module is pure: the embedder is injected. Tests drive it with a fake.
 */

import { shapeFromWord, swatchFromWord } from "../grammar";
import { NO_SPAN, labelSpans } from "../jev";
import { PROTOTYPE_PAIRS } from "./prototypes";

/** Embeds a batch of strings into unit-length vectors, in order. */
export type Embedder = (texts: readonly string[]) => Promise<Float32Array[]>;

/**
 * Below this cosine similarity to its nearest prototype, an utterance is not
 * treated as any command at all. The `none` prototypes do most of this work;
 * the floor catches the genuinely out-of-distribution.
 */
export const SIMILARITY_FLOOR = 0.28;

/**
 * How big a cosine gap counts as decisive.
 *
 * Measured, not guessed: `scripts/local-probe.ts` over utterances this tier is
 * meant to catch puts the top-two gap at 0.07–0.59 when the winner is right and
 * obvious, and at 0.02–0.03 when the top two are genuinely arguable. This value
 * is set so 0.07 clears `MIN_CONFIDENCE` comfortably and 0.03 does not — the
 * arguable cases come back as a refusal rather than a coin flip.
 */
const TEMPERATURE = 0.028;

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot; // inputs are unit-normalised by the embedder
}

/**
 * The winning option and how clearly it won, as a softmax between the best
 * score and the runner-up.
 *
 * Only the top two matter, and that is the point. A softmax over all thirty
 * intents would dilute a decisive winner just because there are many losers —
 * the same true answer would score lower on a longer menu, which is nonsense.
 * The head-to-head has no such defect, and it reduces to `2p - 1`, which is
 * exactly the number the hosted model reports for a two-way call. Both tiers
 * hand `decode()` confidences that mean the same thing, so one set of gates
 * governs both.
 */
function topOf(scores: readonly number[]): { index: number; confidence: number } {
  let first = -Infinity;
  let second = -Infinity;
  let index = -1;
  scores.forEach((s, i) => {
    if (s > first) {
      second = first;
      first = s;
      index = i;
    } else if (s > second) {
      second = s;
    }
  });
  if (index === -1) return { index: -1, confidence: 0 };
  // Sole candidate: nothing disagreed with it, so nothing undermines it.
  if (second === -Infinity) return { index, confidence: 1 };
  return { index, confidence: Math.tanh((first - second) / (2 * TEMPERATURE)) };
}

// ---------------------------------------------------------------------------
// Lexical answers — exact tables, no model
// ---------------------------------------------------------------------------

const DEICTIC = new Set([
  "it", "its", "that", "this", "these", "those", "them", "they", "there",
  "one", "thing", "here",
]);

const DIRECTION_WORDS: Readonly<Record<string, string>> = {
  left: "left", leftwards: "left", west: "left", back: "left",
  right: "right", rightwards: "right", east: "right", across: "right", over: "right",
  up: "up", upward: "up", upwards: "up", north: "up", higher: "up", above: "up",
  down: "down", downward: "down", downwards: "down", south: "down", lower: "down", below: "down",
};

/** Cues that the words immediately after them are a label, not a command. */
const LABEL_CUES = [
  "called", "named", "labelled", "labeled", "saying", "says", "titled",
  "call it", "name it", "that reads", "which says",
];

const PLAIN_LINE = /\b(plain|no arrow|without an arrow|no arrowhead|just a line|simple line)\b/;

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
}

/**
 * Does anything in the sentence name a shape? Scans left to right, trying the
 * two-word phrase at each position before the single word — "data store" is a
 * cylinder, and reading it as "data" then "store" finds neither.
 */
function lexicalShape(utterance: string): string | null {
  const ws = words(utterance);
  for (let i = 0; i < ws.length; i += 1) {
    const pair = i + 1 < ws.length ? shapeFromWord(`${ws[i]} ${ws[i + 1]}`) : null;
    if (pair !== null) return pair;
    const one = shapeFromWord(ws[i] ?? "");
    if (one !== null) return one;
  }
  return null;
}

/**
 * Words that resolve to the `auto` swatch but are far too common in ordinary
 * speech to read as "clear the fill". "Make it the default one" is a colour
 * request; "delete the one on the left, none of the others" is not.
 */
const WEAK_AUTO = new Set(["none", "auto", "automatic", "default"]);

function lexicalSwatch(utterance: string): string | null {
  for (const w of words(utterance)) {
    const name = swatchFromWord(w);
    if (name === null) continue;
    if (name === "auto" && WEAK_AUTO.has(w)) continue;
    return name;
  }
  return null;
}

/**
 * The utterance with the canvas's own nouns swapped for "this".
 *
 * Proper nouns dominate a short sentence's embedding, and they are the part
 * that carries no information about the intent — "wire intake through to the
 * worker" scored 0.24 against every `connect` example, purely because two of
 * its six words are names no prototype could ever contain. Masked, the same
 * sentence scores 0.68. The verb was always there; the names were burying it.
 *
 * Shape words are left alone: "store" may well be in a label, but it is also
 * how someone asks for a cylinder, and the local tier reads shapes lexically
 * out of this same sentence.
 */
function maskItems(utterance: string, items: readonly string[]): string {
  const canvas = new Set<string>();
  for (const item of items) {
    for (const w of words(item)) {
      if (w.length >= 3 && shapeFromWord(w) === null) canvas.add(w);
    }
  }
  if (canvas.size === 0) return utterance;
  return words(utterance)
    .map((w) => (canvas.has(w) ? "this" : w))
    .join(" ");
}

function lexicalDirection(utterance: string): string | null {
  for (const w of words(utterance)) {
    const d = DIRECTION_WORDS[w];
    if (d !== undefined) return d;
  }
  return null;
}

/**
 * The span a naming cue points at, if any. Embeddings are no use for this —
 * "which of these word-runs is a label" is a syntactic question, and the cue
 * words answer it exactly.
 */
function lexicalLabelSpan(utterance: string, spans: readonly string[]): string | null {
  const lower = utterance.toLowerCase();
  for (const cue of LABEL_CUES) {
    const at = lower.indexOf(`${cue} `);
    if (at === -1) continue;
    const after = lower.slice(at + cue.length + 1).trim();
    if (after === "") continue;
    // Prefer the longest offered span that the trailing text starts with, so
    // "called hot path" picks "hot path" over "hot".
    const hit = [...spans]
      .filter((s) => after.startsWith(s))
      .sort((a, b) => b.length - a.length)[0];
    if (hit !== undefined) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

/** Prototype vectors, embedded once and reused for every utterance. */
export interface Prototypes {
  intents: string[];
  vectors: Float32Array[];
}

export async function embedPrototypes(embed: Embedder): Promise<Prototypes> {
  const vectors = await embed(PROTOTYPE_PAIRS.map(([, phrase]) => phrase));
  return { intents: PROTOTYPE_PAIRS.map(([intent]) => intent), vectors };
}

const choice = (value: string, confidence: number) => ({
  type: "choice" as const,
  choice: value,
  confidence,
  probabilities: { [value]: confidence },
});

const noul = (p: number) => ({ type: "noul" as const, noul: p });

/**
 * Produce a Jev-shaped answer set for one utterance.
 *
 * `items` are the labels currently on the canvas, in the order the caller
 * knows them. The returned object is what `decode(raw, utterance, spans)`
 * expects as `raw`.
 */
export async function answerLocally(
  utterance: string,
  items: readonly string[],
  protos: Prototypes,
  embed: Embedder,
): Promise<{ answers: Record<string, unknown> }> {
  const spans = labelSpans(utterance);

  // One batch: the utterance, its masked twin, then every candidate span, then
  // every item. The spans are needed to locate each item within the sentence
  // (below), and one round trip to the worker beats four.
  const masked = maskItems(utterance, items);
  const vecs = await embed([utterance, masked, ...spans, ...items]);
  const uVec = vecs[0];
  const mVec = vecs[1];
  if (uVec === undefined || mVec === undefined) return { answers: {} };
  const spanVecs = vecs.slice(2, 2 + spans.length);
  const itemVecs = vecs.slice(2 + spans.length);

  const answers: Record<string, unknown> = {};

  // --- intent: nearest prototype, pooled per intent -------------------------
  // Scored against both readings, best of the two. Masking can only remove
  // noise the prototypes could never have matched, so taking the max is safe:
  // where there is nothing to mask the twin is the same sentence, and where
  // there is, it is the same sentence with the names taken out.
  const best = new Map<string, number>();
  protos.vectors.forEach((v, i) => {
    const intent = protos.intents[i];
    if (intent === undefined) return;
    const s = Math.max(cosine(uVec, v), cosine(mVec, v));
    best.set(intent, Math.max(best.get(intent) ?? -1, s));
  });

  const intents = [...best.keys()];
  const scores = intents.map((i) => best.get(i) ?? 0);
  const { index, confidence } = topOf(scores);
  const topScore = index === -1 ? 0 : (scores[index] ?? 0);
  const intent = topScore < SIMILARITY_FLOOR ? "none" : (intents[index] ?? "none");
  answers.intent = choice(intent, confidence);

  // --- shape / colour / direction / arrowheads: exact tables ----------------
  const shape = lexicalShape(utterance);
  answers.shape_stated = noul(shape === null ? 0.02 : 0.98);
  answers.shape = choice(shape ?? "rect", shape === null ? 0 : 1);

  const swatch = lexicalSwatch(utterance);
  answers.color_stated = noul(swatch === null ? 0.02 : 0.98);
  answers.color = choice(swatch ?? "auto", swatch === null ? 0 : 1);

  const dir = lexicalDirection(utterance);
  answers.direction = choice(dir ?? "right", dir === null ? 0 : 1);

  answers.arrowhead = noul(PLAIN_LINE.test(utterance.toLowerCase()) ? 0.02 : 0.9);

  const span = lexicalLabelSpan(utterance, spans);
  answers.label_span = choice(span ?? NO_SPAN, span === null ? 1 : 0.95);

  // --- which item on the canvas --------------------------------------------
  if (items.length > 0) {
    const mentions = findMentions(utterance, items, spans, spanVecs, itemVecs, uVec);

    // Presence, asked apart from identity for the same reason the hosted tier
    // asks it apart: "the selected one" is not a rival answer to a node's name,
    // and forcing them to compete manufactures doubt where there is none.
    const evidence = Math.max(0, ...mentions.map((m) => m.score));
    const named = evidence >= NAMED_FLOOR;
    // A better match is better evidence that they named something, up to a
    // point — nothing here is ever certain enough to report as 1.
    answers.target_named = noul(named ? Math.min(0.97, 0.5 + evidence / 1.4) : 0.05);

    // Two things can go wrong, and both have to count. The words that referred
    // to an item may fit another item just as well ("the store thing" with two
    // stores on the canvas) — that lives in the mention's own confidence. Or
    // the sentence may refer clearly to two different items, in which case
    // there is no single target however clear each reference was. Whichever is
    // shakier decides, so a `delete` is refused in either case.
    const perItem = items.map((_, i) => mentions.find((m) => m.index === i)?.score ?? 0);
    const top = topOf(perItem);
    const winner = mentions.find((m) => m.index === top.index);
    answers.target = choice(
      items[top.index] ?? "",
      Math.min(top.confidence, winner?.confidence ?? 0),
    );

    // Order is what makes a connector a connector, and similarity is symmetric
    // — it cannot tell source from destination. Word order can: each mention
    // knows where in the sentence it was made, and the earlier one is the
    // source. Nothing is invented: an utterance that mentions fewer than two
    // items yields no endpoints and `decode` declines to draw anything.
    if (items.length > 1) {
      const order = [...mentions].sort((a, b) => a.at - b.at);
      const [from, to] = order;
      if (from !== undefined && to !== undefined) {
        // `decode` counts both endpoints, so each carries its own number.
        answers.connect_from = choice(from.label, from.confidence);
        answers.connect_to = choice(to.label, to.confidence);
      }
    }
  }

  return { answers };
}

/** Similarity at which a description is a good enough match to act on. */
const NAMED_FLOOR = 0.45;
/** Below this, a run of words is not referring to any item at all. */
const MENTION_FLOOR = 0.4;
/** Credit for reusing a word straight out of a label. Strong, but not certain. */
const BORROWED = 0.9;

interface Mention {
  index: number;
  label: string;
  /** Character offset of the words that referred to it. */
  at: number;
  /** How good the match is, 0–1. */
  score: number;
  /** How clearly it beat the runner-up item for the same words. */
  confidence: number;
}

/**
 * Which items the utterance refers to, where, and how surely.
 *
 * Matching is done span by span rather than against the whole sentence. The
 * sentence contains the verb and often both endpoints, so even a perfect
 * reference to one item scores middling against all of it; "the storage thing"
 * on its own scores properly. Spans also carry a position, which is the only
 * way to tell a connector's source from its destination.
 *
 * Whole-sentence similarity is still consulted as a floor, for the case where
 * the reference is spread too thin for any single span to catch it.
 */
function findMentions(
  utterance: string,
  items: readonly string[],
  spans: readonly string[],
  spanVecs: readonly Float32Array[],
  itemVecs: readonly Float32Array[],
  uVec: Float32Array,
): Mention[] {
  const lower = utterance.toLowerCase();
  const ws = words(utterance).filter((w) => !DEICTIC.has(w));
  const best = new Map<number, Mention>();

  const offer = (m: Mention): void => {
    const prev = best.get(m.index);
    if (prev === undefined || m.score > prev.score) best.set(m.index, m);
  };

  spans.forEach((span, i) => {
    const sv = spanVecs[i];
    if (sv === undefined) return;
    const at = lower.indexOf(span);
    if (at === -1) return;

    // Borrowing a word out of a label is the strongest signal there is, and it
    // is the one an embedding is worst at: two labels sharing a word look
    // equally close to it, which is exactly right — that ambiguity should show
    // up as low confidence, not be resolved by a coin flip.
    const scores = items.map((label, j) => {
      const lexical = words(span).some((w) => ws.includes(w) && inLabel(w, label)) ? BORROWED : 0;
      return Math.max(lexical, cosine(sv, itemVecs[j] ?? EMPTY));
    });

    const { index, confidence } = topOf(scores);
    const score = scores[index] ?? 0;
    if (index === -1 || score < MENTION_FLOOR) return;
    offer({ index, label: items[index] ?? "", at, score, confidence });
  });

  // Fallback: the reference was never concentrated in one run of words.
  if (best.size === 0) {
    const scores = items.map((_, j) => cosine(uVec, itemVecs[j] ?? EMPTY));
    const { index, confidence } = topOf(scores);
    const score = scores[index] ?? 0;
    if (index !== -1 && score >= NAMED_FLOOR) {
      offer({ index, label: items[index] ?? "", at: 0, score, confidence });
    }
  }

  return [...best.values()];
}

const EMPTY = new Float32Array(0);

/** Did they reuse a word from this label? Containment, no fuzziness. */
function inLabel(word: string, label: string): boolean {
  return word.length >= 3 && words(label).includes(word);
}
