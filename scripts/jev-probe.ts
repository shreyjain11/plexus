/**
 * Live check of the voice fallback against TypeSafe's Jev.
 *
 * Not part of the test suite — the suite must stay offline and free. This is
 * the thing you run by hand after touching `src/voice/jev.ts`, to confirm the
 * questions still read the way you think they do against the real model.
 *
 *   set -a && . ./.env.local && set +a && npx vite-node scripts/jev-probe.ts
 *
 * Each case is a phrasing the in-browser grammar deliberately does not cover,
 * paired with what the app should end up doing.
 */

import { buildRequest, decode } from "../src/voice/jev";

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

const KEY = process.env.VOICE_API_KEY;
const BASE = (process.env.VOICE_API_BASE ?? "https://api.typesafe.ai").replace(/\/+$/, "");
const MODEL = process.env.VOICE_MODEL ?? "jev-latest";

if (!KEY) {
  console.error("VOICE_API_KEY is not set. Source .env.local first.");
  process.exitCode = 1;
  throw new Error("missing key");
}

interface Case {
  readonly say: string;
  readonly on?: readonly string[];
  readonly want: string;
}

const CASES: readonly Case[] = [
  { say: "chuck a database on there called hot path", want: "add cylinder 'Hot Path'" },
  { say: "i reckon we need a decision here", want: "add diamond" },
  { say: "make that one a sort of warm orange", on: ["Intake"], want: "fill orange" },
  { say: "get rid of the storage thing", on: ["Intake", "Object Store"], want: "delete Object Store" },
  { say: "run a line from the queue into the worker", on: ["Queue", "Worker"], want: "connect Queue→Worker" },
  { say: "that looks like a mess, sort it out", on: ["A", "B"], want: "tidy" },
  // Genuinely ambiguous — "that last bit" is either the last action or a thing
  // on the canvas. Refusing and saying so beats picking one.
  { say: "scrap that last bit", on: ["Intake"], want: "undo, or a refusal" },
  { say: "it's too bright in here", want: "theme dark" },
  { say: "shove it over to the right a touch", on: ["Intake"], want: "move right" },
  { say: "actually call it Archive instead", on: ["Intake"], want: "rename → Archive" },
  { say: "what's the weather like", want: "nothing (not a command)" },
  { say: "hmm", want: "nothing (not a command)" },
];

let failures = 0;

for (const c of CASES) {
  const { state, questions, spans } = buildRequest(c.say, c.on ?? []);
  const res = await fetch(`${BASE}/v1/systemone`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ state, model: MODEL, questions }),
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}  ${c.say}`);
    failures += 1;
    continue;
  }

  const payload = (await res.json()) as { usage?: { input_tokens: number; output_tokens: number } };
  const { ops, confidence, intent } = decode(payload, c.say, spans);

  console.log(`“${c.say}”`);
  console.log(`   want  ${c.want}`);
  console.log(`   got   ${intent} @ ${confidence.toFixed(2)} → ${JSON.stringify(ops)}`);
  console.log(
    `   cost  ${payload.usage?.input_tokens ?? "?"} in / ${payload.usage?.output_tokens ?? "?"} out`,
  );
  console.log();
}

if (failures > 0) process.exitCode = 1;
