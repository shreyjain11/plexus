import { validateOps, type VoiceOp } from "./ops";

/**
 * The optional second tier: ask a language model to parse an utterance the
 * offline grammar did not understand.
 *
 * The model is reached through `/api/voice`, a serverless route that holds the
 * API key. Nothing secret ever reaches the browser, and the app works fully
 * without the route — a deploy with no key configured answers 501, which this
 * client latches onto so it stops asking for the rest of the session.
 */

export type RemoteStatus = "unknown" | "ready" | "unconfigured" | "error";

const ENDPOINT = "/api/voice";
const TIMEOUT_MS = 8000;

/** Set once the server says it has no key; suppresses all further requests. */
let unconfigured = false;

export function remoteDisabled(): boolean {
  return unconfigured;
}

/** Test seam — resets the latched 501 between cases. */
export function resetRemote(): void {
  unconfigured = false;
}

export interface RemoteResult {
  ops: VoiceOp[];
  status: RemoteStatus;
}

/**
 * Send one utterance for parsing. Never throws: a network failure, a timeout,
 * a bad payload, and a model that returned prose all come back as zero ops.
 */
export async function parseRemote(
  text: string,
  context: { labels: string[] },
  signal?: AbortSignal,
): Promise<RemoteResult> {
  if (unconfigured || text.trim() === "") return { ops: [], status: "unconfigured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Only the words spoken and the node labels already on screen — the
      // model never needs coordinates, ids, or anything else from the doc.
      body: JSON.stringify({ text, labels: context.labels.slice(0, 60) }),
      signal: controller.signal,
    });

    if (res.status === 501) {
      unconfigured = true;
      return { ops: [], status: "unconfigured" };
    }
    if (!res.ok) return { ops: [], status: "error" };

    const body: unknown = await res.json();
    const ops =
      typeof body === "object" && body !== null && "ops" in body
        ? validateOps((body as { ops: unknown }).ops)
        : [];
    return { ops, status: "ready" };
  } catch {
    return { ops: [], status: "error" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
