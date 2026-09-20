import { buildRequest, decode } from "../src/voice/jev";
import { validateOps } from "../src/voice/ops";

/**
 * Optional second-tier voice parser, backed by TypeSafe's Jev.
 *
 * Plexus understands its command vocabulary entirely in the browser. This
 * route exists only for the phrasings the offline grammar declines, and it is
 * optional in the strictest sense: with no key configured it answers 501 and
 * the client permanently stops asking, so a plain static deploy behaves
 * exactly as it did before this file existed.
 *
 * This is only transport. The question set and the answer → op decoding live
 * in `src/voice/jev.ts`, which is pure and unit-tested; everything here is
 * auth, limits, timeouts, and not leaking the upstream's error body.
 *
 * The key is read from the server environment and never leaves it. It is not
 * `VITE_`-prefixed, so Vite cannot inline it into the client bundle.
 *
 * Environment variables (set them in the Vercel dashboard, or `.env.local`
 * for `vercel dev`):
 *   VOICE_API_KEY   required — the TypeSafe API key
 *   VOICE_API_BASE  optional — API origin
 *   VOICE_MODEL     optional — model id
 */

export const config = { runtime: "nodejs" };

// `@types/node` is not a dependency — the client bundle has no use for it and
// this is the only file that touches a Node global. Declaring the one member
// we read keeps this route inside `npm run typecheck` without the install.
declare const process: { env: Record<string, string | undefined> };

const DEFAULT_BASE = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const EVALUATE_PATH = "/v1/systemone";

const MAX_TEXT = 400;
const MAX_LABELS = 60;
const MAX_LABEL_LEN = 120;
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Best-effort per-instance rate limit: enough to blunt a stray loop. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 40;
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear(); // crude bound; this is not a shared store
  return recent.length > RATE_MAX;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }

  const apiKey = process.env.VOICE_API_KEY;
  if (!apiKey) {
    // The client latches onto 501 and stops sending — this is the normal
    // state of a deploy that has not opted into the model tier.
    return json({ error: "voice model not configured", ops: [] }, 501);
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  if (rateLimited(ip)) return json({ error: "slow down", ops: [] }, 429);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "expected JSON", ops: [] }, 400);
  }
  if (typeof body !== "object" || body === null) return json({ error: "expected JSON", ops: [] }, 400);

  const { text, labels } = body as { text?: unknown; labels?: unknown };
  if (typeof text !== "string" || text.trim() === "") {
    return json({ error: "missing text", ops: [] }, 400);
  }
  const utterance = text.trim().slice(0, MAX_TEXT);
  const known = isStringArray(labels)
    ? labels.slice(0, MAX_LABELS).map((l) => l.slice(0, MAX_LABEL_LEN))
    : [];

  const base = (process.env.VOICE_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");
  const model = process.env.VOICE_MODEL ?? DEFAULT_MODEL;
  const { state, questions, spans } = buildRequest(utterance, known);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${base}${EVALUATE_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ state, model, questions }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      // Never forward the provider's body — it can echo request details. 429
      // and 529 are the documented "back off" cases; pass 429 through so the
      // browser can tell "too fast" from "broken".
      const status = upstream.status === 429 ? 429 : 502;
      return json({ error: `model request failed (${upstream.status})`, ops: [] }, status);
    }

    const payload: unknown = await upstream.json();
    const { ops, confidence, intent } = decode(payload, utterance, spans);
    // `decode` only ever emits ops it built itself, so this is belt-and-braces
    // — but it is the same gate the grammar's output passes through, and the
    // op contract should have exactly one enforcement point.
    return json({ ops: validateOps(ops), confidence, intent });
  } catch {
    return json({ error: "model request failed", ops: [] }, 502);
  } finally {
    clearTimeout(timer);
  }
}
