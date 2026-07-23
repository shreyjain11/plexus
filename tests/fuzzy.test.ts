import { describe, expect, it } from "vitest";
import { fuzzyRank, fuzzyScore } from "../src/util/fuzzy";

describe("fuzzyScore", () => {
  it("matches subsequences and rejects non-subsequences", () => {
    expect(fuzzyScore("rect", "Insert rectangle")).not.toBeNull();
    expect(fuzzyScore("irect", "Insert rectangle")).not.toBeNull();
    expect(fuzzyScore("xyz", "Insert rectangle")).toBeNull();
  });

  it("is case-insensitive and treats an empty query as match-all", () => {
    expect(fuzzyScore("SVG", "Export SVG")).not.toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("   ", "anything")).toBe(0);
  });

  it("prefers word starts and consecutive runs", () => {
    const wordStart = fuzzyScore("dark", "Switch to dark theme")!;
    const scattered = fuzzyScore("dark", "Load sample pathway; try drawing a rectangle marker")!;
    expect(wordStart).toBeGreaterThan(scattered ?? -Infinity);
  });
});

describe("fuzzyRank", () => {
  const items = [
    { id: "a", title: "Insert rectangle" },
    { id: "b", title: "Insert ellipse" },
    { id: "c", title: "Export SVG" },
    { id: "d", title: "Switch to dark theme" },
  ];

  it("ranks the intuitive winner first and drops non-matches", () => {
    const ranked = fuzzyRank("rect", items, (i) => [i.title]);
    expect(ranked[0]?.id).toBe("a");
    expect(ranked.find((i) => i.id === "d")).toBeUndefined();
  });

  it("returns everything (stable) for an empty query", () => {
    expect(fuzzyRank("", items, (i) => [i.title])).toHaveLength(items.length);
  });

  it("searches across multiple fields", () => {
    const withKeywords = fuzzyRank("night", items, (i) => [
      i.title,
      i.id === "d" ? "dark night mode" : "",
    ]);
    expect(withKeywords[0]?.id).toBe("d");
  });
});
