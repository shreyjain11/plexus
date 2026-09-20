/// <reference lib="webworker" />

/**
 * The embedding model, kept off the main thread.
 *
 * MiniLM is small but it is not free to run: a batch of ~150 prototype
 * sentences takes a second or two on WASM, and doing that on the UI thread
 * would freeze the canvas mid-sentence — on a drawing app, while the user is
 * drawing. So the model lives here and the page talks to it in messages.
 *
 * The model is loaded once, lazily, on the first request. Nothing is fetched
 * until someone actually turns the free tier on.
 */

import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

/**
 * Sentence embeddings, int8: 23 MB against 90 MB for fp32, for a loss on short
 * imperative sentences that does not show up in nearest-neighbour ranking. The
 * first-run download is the whole cost of this tier, so it is the number worth
 * minimising — though the ONNX runtime beside it is another ~7 MB gzipped, and
 * that one is not ours to shrink.
 */
const MODEL = "Xenova/all-MiniLM-L6-v2";

// Nothing here ships with the app; everything comes from the HF CDN and then
// the browser's own cache.
env.allowLocalModels = false;

export interface EmbedRequest {
  kind: "embed";
  id: number;
  texts: string[];
}
export type WorkerRequest = EmbedRequest;

export type WorkerResponse =
  | { kind: "progress"; loaded: number; total: number }
  | { kind: "ready" }
  | { kind: "embedded"; id: number; dims: number; data: Float32Array }
  | { kind: "failed"; id: number | null; message: string };

const post = (m: WorkerResponse, transfer?: Transferable[]): void => {
  if (transfer) self.postMessage(m, transfer);
  else self.postMessage(m);
};

let loading: Promise<FeatureExtractionPipeline> | null = null;

function extractor(): Promise<FeatureExtractionPipeline> {
  // Concurrent requests during the first load must await the same promise, not
  // start a second download of the same 23 MB.
  loading ??= pipeline("feature-extraction", MODEL, {
    dtype: "int8",
    progress_callback: (p: unknown) => {
      const r = p as { status?: string; loaded?: number; total?: number };
      if (r.status === "progress" && typeof r.loaded === "number" && typeof r.total === "number") {
        post({ kind: "progress", loaded: r.loaded, total: r.total });
      }
    },
  }).then((p) => {
    post({ kind: "ready" });
    return p;
  });
  return loading;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg?.kind !== "embed") return;
  void (async () => {
    try {
      const extract = await extractor();
      if (msg.texts.length === 0) {
        post({ kind: "embedded", id: msg.id, dims: 0, data: new Float32Array(0) });
        return;
      }
      // Normalised here so the reader's cosine is a plain dot product.
      const out = await extract(msg.texts, { pooling: "mean", normalize: true });
      const dims = out.dims[out.dims.length - 1] ?? 0;
      // Copy out of the tensor's buffer: it is reused, and the copy is what
      // makes the transfer below safe.
      const data = new Float32Array(out.data as Float32Array);
      post({ kind: "embedded", id: msg.id, dims, data }, [data.buffer]);
    } catch (err) {
      // A failed load must not leave a rejected promise cached as "the model",
      // or every later request fails instantly with a stale error.
      loading = null;
      post({ kind: "failed", id: msg.id, message: err instanceof Error ? err.message : String(err) });
    }
  })();
};
