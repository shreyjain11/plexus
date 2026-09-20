/**
 * Run the free tier against the real model, outside the browser.
 *
 * The unit tests drive a fake embedder, so they check our arithmetic and prove
 * nothing about whether MiniLM actually puts "it's too bright in here" near
 * "turn the lights down". That is the only question that matters for this tier,
 * and it can only be answered by downloading the model and asking it.
 *
 *   npx vite-node scripts/local-probe.ts
 *
 * Deliberately not part of `npm test`: it fetches ~23 MB on first run and is a
 * judgement call on output, not a pass/fail.
 */

import { pipeline } from "@huggingface/transformers";
import { answerLocally, embedPrototypes, type Embedder } from "../src/voice/local/answer";
import { buildRequest, decode } from "../src/voice/jev";

const CANVAS = ["Intake", "Object Store", "Worker"];

/** Phrasings tier 1 cannot parse — the ones this tier has to earn its keep on. */
const CASES: ReadonlyArray<readonly [string, string]> = [
  ["it's way too bright in here", "theme_dark"],
  ["my eyes are killing me", "theme_dark"],
  ["i can't read any of this", "zoom_in"],
  ["let me see the whole thing at once", "zoom_out"],
  ["this diagram is a complete mess", "tidy"],
  ["we're missing a decision point here", "add"],
  ["there should be a queue in this somewhere", "add"],
  ["nah, that's not what i meant", "undo"],
  ["get rid of the storage thing", "delete"],
  ["wire intake through to the worker", "connect"],
  ["chuck a data store on there called Cold Tier", "add"],
  ["i have no idea how any of this works", "help"],
  ["what did you have for breakfast", "none"],
  ["hang on, let me think for a second", "none"],
];

const t0 = Date.now();
const extract = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "int8" });
console.log(`model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const embed: Embedder = async (texts) => {
  const out = await extract([...texts], { pooling: "mean", normalize: true });
  const dims = out.dims[out.dims.length - 1] ?? 0;
  const data = out.data as Float32Array;
  const vecs: Float32Array[] = [];
  for (let i = 0; i + dims <= data.length; i += dims) vecs.push(data.slice(i, i + dims));
  return vecs;
};

const t1 = Date.now();
const protos = await embedPrototypes(embed);
console.log(`${protos.vectors.length} prototypes embedded in ${Date.now() - t1}ms\n`);

let right = 0;
for (const [utterance, want] of CASES) {
  const started = Date.now();
  const { spans, state } = buildRequest(utterance, CANVAS);
  const raw = await answerLocally(utterance, state.existing_items, protos, embed);
  const out = decode(raw, utterance, spans);
  const ms = Date.now() - started;

  const hit = out.intent === want;
  if (hit) right += 1;
  const acted = out.ops.length > 0;
  const mark = hit ? (acted || want === "none" ? "ok  " : "shy ") : "MISS";
  console.log(`${mark} ${ms.toString().padStart(4)}ms  ${utterance}`);
  console.log(`        want ${want}  got ${out.intent} @ ${out.confidence.toFixed(2)}`);
  if (out.ops.length > 0) console.log(`        ${JSON.stringify(out.ops)}`);
}

console.log(`\n${right}/${CASES.length} intents correct`);
