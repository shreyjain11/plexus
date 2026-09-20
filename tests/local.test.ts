import { describe, expect, it } from "vitest";
import { answerLocally, cosine, embedPrototypes, type Embedder } from "../src/voice/local/answer";
import { PROTOTYPES } from "../src/voice/local/prototypes";
import { buildRequest, decode } from "../src/voice/jev";

/**
 * The local tier without the model.
 *
 * Nothing here downloads MiniLM. A real embedding test would be a test of
 * MiniLM, which is not ours and does not change; what can break is our side —
 * the batching offsets, the lexical tables, the confidence arithmetic, and the
 * handoff into the shared decoder. So the embedder is a stub with hand-written
 * similarities, and every case states what the model is supposed to have
 * thought.
 */

/**
 * A fake embedder built from a similarity table.
 *
 * Each text gets a one-hot-ish vector in a space with one axis per "topic", so
 * a dot product between two texts is whatever the table says. Texts with no
 * entry are orthogonal to everything, i.e. similarity 0.
 */
function fakeEmbedder(sims: Record<string, Record<string, number>>): Embedder {
  // One axis per distinct string ever seen, assigned on demand. Anything not in
  // the table is therefore orthogonal to everything else rather than identical
  // to every other unknown — which is the whole point, since most of what gets
  // embedded here (candidate spans, prototype phrases) is deliberately absent.
  const axis = new Map<string, number>();
  const axisOf = (s: string): number => {
    const found = axis.get(s);
    if (found !== undefined) return found;
    axis.set(s, axis.size);
    return axis.size - 1;
  };
  for (const [text, row] of Object.entries(sims)) {
    axisOf(text);
    for (const other of Object.keys(row)) axisOf(other);
  }

  const WIDTH = 512;
  return (texts) =>
    Promise.resolve(
      texts.map((t) => {
        const v = new Float32Array(WIDTH);
        v[axisOf(t) % WIDTH] = 1;
        for (const [other, s] of Object.entries(sims[t] ?? {})) v[axisOf(other) % WIDTH] = s;
        return v;
      }),
    );
}

/** Prototypes where the listed phrases are the only ones the utterance matches. */
async function protosFor(utterance: string, matches: Record<string, number>) {
  return embedPrototypes(fakeEmbedder({ [utterance]: matches }));
}

/** Answer, then decode — the real pipeline minus the model and the worker. */
async function run(
  utterance: string,
  matches: Record<string, number>,
  items: string[] = [],
  extraSims: Record<string, Record<string, number>> = {},
) {
  const sims = { [utterance]: matches, ...extraSims };
  const embed = fakeEmbedder(sims);
  const protos = await embedPrototypes(embed);
  const { spans, state } = buildRequest(utterance, items);
  const raw = await answerLocally(utterance, state.existing_items, protos, embed);
  return { ...decode(raw, utterance, spans), answers: raw.answers };
}

describe("cosine", () => {
  it("is a dot product over unit vectors", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });

  it("tolerates a length mismatch rather than reading past the end", () => {
    expect(cosine(new Float32Array([1, 0, 0]), new Float32Array([1]))).toBeCloseTo(1);
  });
});

describe("prototypes", () => {
  it("covers every intent the decoder can act on", async () => {
    const protos = await protosFor("x", {});
    expect(new Set(protos.intents)).toEqual(new Set(Object.keys(PROTOTYPES)));
  });

  it("embeds one vector per phrase, aligned with its intent", async () => {
    const protos = await protosFor("x", {});
    const phrases = Object.values(PROTOTYPES).flat();
    expect(protos.vectors).toHaveLength(phrases.length);
    expect(protos.intents).toHaveLength(phrases.length);
  });
});

describe("intent", () => {
  it("routes an oblique phrasing by its nearest example", async () => {
    // The whole reason this tier exists: no word in common with "dark".
    const out = await run("the screen is searing my retinas", { "my eyes hurt": 0.71 });
    expect(out.intent).toBe("theme_dark");
    expect(out.ops).toEqual([{ op: "theme", theme: "dark" }]);
  });

  it("refuses when nothing on the menu is close", async () => {
    const out = await run("what time does the shop shut", { "add a box": 0.11 });
    expect(out.intent).toBe("none");
    expect(out.ops).toEqual([]);
  });

  it("lands on none when chitchat is the nearest neighbour", async () => {
    const out = await run("anyway where was i", { "so anyway, as i was saying": 0.8, "add a box": 0.3 });
    expect(out.intent).toBe("none");
    expect(out.ops).toEqual([]);
  });

  it("refuses a close call between two commands", async () => {
    // Two intents a hair apart is exactly when acting is worst, and it is the
    // case a plain "nearest neighbour wins" would get confidently wrong.
    const out = await run("take that off", { "delete that": 0.62, "undo that": 0.615 });
    expect(out.ops).toEqual([]);
  });

  it("acts on a clear winner over a plausible runner-up", async () => {
    const out = await run("blow it up a bit", { "zoom in": 0.7, "make it smaller": 0.45 });
    expect(out.intent).toBe("zoom_in");
    expect(out.ops).toEqual([{ op: "zoom", dir: "in" }]);
  });
});

describe("masking the canvas's nouns", () => {
  it("recognises an intent that only the masked sentence matches", async () => {
    // The live model scores "wire intake through to the worker" at 0.24 against
    // every connect example and 0.68 once the two names are out of the way.
    // Here the fake says the same thing bluntly: the raw sentence matches
    // nothing, the masked one matches connect.
    const out = await run(
      "wire intake through to the worker",
      {},
      ["Intake", "Worker"],
      {
        "wire this through to the this": { "wire this one into that one": 0.8 },
        intake: { Intake: 0.95 },
        worker: { Worker: 0.95 },
      },
    );
    expect(out.intent).toBe("connect");
    expect(out.ops[0]).toMatchObject({ op: "connect", chain: ["Intake", "Worker"] });
  });

  it("leaves a shape word alone even when a label contains it", async () => {
    // "store" is both a word in the label and how someone asks for a cylinder.
    // Masking it would cost the shape, so it stays.
    const out = await run("add a data store", { "add a box": 0.9 }, ["Object Store"]);
    expect(out.ops).toEqual([{ op: "add", shape: "cylinder" }]);
  });
});

describe("the lexical half", () => {
  it("reads the shape from the grammar's own synonyms", async () => {
    const out = await run("we're missing a data store here", { "there should be a data store in this": 0.8 });
    expect(out.ops).toEqual([{ op: "add", shape: "cylinder" }]);
  });

  it("falls back to a plain box when no shape is named", async () => {
    const out = await run("we need something here", { "we need a step here": 0.8 });
    expect(out.ops).toEqual([{ op: "add", shape: "rect" }]);
  });

  it("picks the label out of the sentence, not the whole sentence", async () => {
    const out = await run("we need a box called hot path", { "add a box": 0.8 });
    expect(out.ops).toEqual([{ op: "add", shape: "rect", label: "Hot Path" }]);
  });

  it("does not invent a label when no naming cue is present", async () => {
    const out = await run("stick a diamond in there", { "add a box": 0.8 });
    expect(out.ops).toEqual([{ op: "add", shape: "diamond" }]);
  });

  it("maps a colour word onto its swatch", async () => {
    const out = await run("make that one navy", { "make it orange": 0.8 }, ["Intake"]);
    expect(out.ops[0]).toMatchObject({ op: "fill", color: "#eef2fb" });
  });

  it("does not hear a colour in an ordinary 'none'", async () => {
    // "none" resolves to the auto swatch in the grammar, but hearing it in
    // passing is not a request to clear a fill.
    const out = await run("none of these are right, get rid of it", { "get rid of it": 0.9 });
    expect(out.intent).toBe("delete");
    expect(out.ops).toEqual([{ op: "delete" }]);
  });

  it("reads an explicit 'plain' as clearing the fill", async () => {
    const out = await run("make it plain again", { "make it orange": 0.8 }, ["Intake"]);
    expect(out.ops[0]).toMatchObject({ op: "fill", color: "" });
  });

  it("takes the direction from the words, not the model", async () => {
    const out = await run("shove that downwards", { "shift that over a bit": 0.8 }, ["Intake"]);
    expect(out.ops[0]).toMatchObject({ op: "move", dy: 40 });
  });

  it("keeps the arrowhead unless a plain line is asked for", async () => {
    const both = ["Intake", "Store"];
    const sims = { "intake": { Intake: 0.9 }, "store": { Store: 0.9 } };
    const withArrow = await run("intake into store", { "connect these two": 0.8 }, both, sims);
    expect(withArrow.ops[0]).toMatchObject({ op: "connect", arrow: true });

    const plain = await run("intake to store, just a line", { "connect these two": 0.8 }, both, sims);
    expect(plain.ops[0]).toMatchObject({ op: "connect", arrow: false });
  });
});

describe("pointing at things on the canvas", () => {
  it("leaves the target open when the words only point", async () => {
    const out = await run("get rid of that", { "get rid of it": 0.9 }, ["Intake", "Store"]);
    expect(out.ops).toEqual([{ op: "delete" }]);
  });

  it("targets an item the speaker named outright", async () => {
    const out = await run("delete the intake one", { "remove this box": 0.9 }, ["Intake", "Store"]);
    expect(out.ops).toEqual([{ op: "delete", target: "Intake" }]);
  });

  it("targets an item the speaker only described", async () => {
    // No shared word with "Object Store" — this is the case a lexicon loses.
    const out = await run(
      "get rid of the storage thing",
      { "we don't need the storage one": 0.9, "Object Store": 0.62 },
      ["Intake", "Object Store"],
    );
    expect(out.ops).toEqual([{ op: "delete", target: "Object Store" }]);
  });

  it("does not let a shaky choice between items run a delete", async () => {
    // Destructive commands clear a higher bar, and "which one" is load-bearing.
    const out = await run(
      "bin the store thing",
      { "bin that node": 0.9, "Object Store": 0.6, "Blob Store": 0.599 },
      ["Object Store", "Blob Store"],
    );
    expect(out.ops).toEqual([]);
  });
});

describe("connectors", () => {
  const items = ["Intake", "Worker"];

  it("takes the source from whichever endpoint is said first", async () => {
    const out = await run(
      "wire intake through to worker",
      { "wire this one into that one": 0.85 },
      items,
      { intake: { Intake: 0.95 }, worker: { Worker: 0.95 } },
    );
    expect(out.ops[0]).toMatchObject({ op: "connect", chain: ["Intake", "Worker"] });
  });

  it("reverses when the sentence names them the other way round", async () => {
    const out = await run(
      "worker gets fed by intake",
      { "this one should point at that one": 0.85 },
      items,
      { worker: { Worker: 0.95 }, intake: { Intake: 0.95 } },
    );
    expect(out.ops[0]).toMatchObject({ op: "connect", chain: ["Worker", "Intake"] });
  });

  it("makes no connector it cannot ground in two items", async () => {
    // Only one endpoint is anywhere in the sentence; guessing the other would
    // draw an arrow the speaker never asked for.
    const out = await run("join intake up to the thing", { "join them up": 0.85 }, items, {
      intake: { Intake: 0.95 },
    });
    expect(out.ops).toEqual([]);
  });
});

describe("the shared decoder", () => {
  it("receives answers in Jev's own wire shape", async () => {
    const out = await run("brighten it up", { "brighten it up": 0.9 });
    expect(out.answers.intent).toMatchObject({ type: "choice", choice: "theme_light" });
    expect(out.answers.shape_stated).toMatchObject({ type: "noul" });
    expect(typeof (out.answers.arrowhead as { noul: number }).noul).toBe("number");
  });

  it("only offers label spans the decoder was told about", async () => {
    const utterance = "add a box called hot path";
    const { spans } = buildRequest(utterance, []);
    const embed = fakeEmbedder({ [utterance]: { "add a box": 0.9 } });
    const protos = await embedPrototypes(embed);
    const { answers } = await answerLocally(utterance, [], protos, embed);
    const picked = (answers.label_span as { choice: string }).choice;
    expect([...spans, "__none__"]).toContain(picked);
  });

  it("never asks the decoder to choose an item that is not on the canvas", async () => {
    const items = ["Intake", "Store"];
    const utterance = "select the intake";
    const embed = fakeEmbedder({ [utterance]: { "pick the database": 0.8 } });
    const protos = await embedPrototypes(embed);
    const { answers } = await answerLocally(utterance, items, protos, embed);
    expect(items).toContain((answers.target as { choice: string }).choice);
  });
});
