/**
 * Tiny subsequence fuzzy matcher for the command palette.
 *
 * Every query character must appear in order in the candidate. Higher scores
 * are better; null means no match. The heuristics are the classic trio:
 * consecutive-run bonuses, word-boundary bonuses, and a mild penalty for
 * matching late in the string — enough for a ~25-command palette without
 * dragging in a library.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const t = text.toLowerCase();

  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    if (found === prevMatch + 1) score += 8; // consecutive run
    if (found === 0 || t[found - 1] === " " || t[found - 1] === "-") score += 6; // word start
    score -= Math.min(found - ti, 10) * 0.5; // gap penalty
    prevMatch = found;
    ti = found + 1;
  }
  score -= t.length * 0.05; // gentle tiebreak toward shorter titles
  return score;
}

/** Rank `items` by best fuzzy score across the given fields; drops non-matches. */
export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  fields: (item: T) => string[],
): T[] {
  return items
    .map((item) => {
      let best: number | null = null;
      for (const f of fields(item)) {
        const s = fuzzyScore(query, f);
        if (s !== null && (best === null || s > best)) best = s;
      }
      return { item, best };
    })
    .filter((r): r is { item: T; best: number } => r.best !== null)
    .sort((a, b) => b.best - a.best)
    .map((r) => r.item);
}
