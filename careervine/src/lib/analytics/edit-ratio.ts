/**
 * How much of an AI-generated draft survived to send (CAR-38 AI-acceptance
 * metric): 1 = sent verbatim, 0 = fully rewritten.
 *
 * Word-level Dice coefficient over tag-stripped text — cheap (linear),
 * order-insensitive enough for "did they keep the substance", and stable on
 * long bodies where character-level edit distance would be O(n²).
 */
export function editRatio(generatedHtml: string, sentHtml: string): number {
  const words = (html: string) =>
    html
      .replace(/<[^>]*>/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

  const a = words(generatedHtml);
  const b = words(sentHtml);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const w of a) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of b) {
    const c = counts.get(w) ?? 0;
    if (c > 0) {
      shared++;
      counts.set(w, c - 1);
    }
  }
  return Math.round(((2 * shared) / (a.length + b.length)) * 100) / 100;
}
