const STOP = new Set("a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our should that the their them there these they this those to us was we were what when where which who why with would you your".split(" "));

/** Keep a contiguous source window around useful query terms. Never rewrite its words. */
export function excerpt(text: string, query: string, budget = 700) {
  if (!Number.isInteger(budget) || budget < 40) throw new Error("Excerpt budget must be an integer of at least 40");
  if (text.length <= budget) return text;
  const terms = new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((s) => s.length > 2 && !STOP.has(s)));
  const matches = [...text.matchAll(/[\p{L}\p{N}]+/gu)].filter((m) => terms.has(m[0].toLowerCase()));
  let start = 0;
  let best = -1;
  for (const match of matches) {
    const candidate = Math.max(0, Math.min(text.length - budget, match.index - Math.floor(budget / 3)));
    const inside = matches.filter((m) => m.index >= candidate && m.index + m[0].length <= candidate + budget);
    const score = new Set(inside.map((m) => m[0].toLowerCase())).size;
    if (score > best) { best = score; start = candidate; }
  }
  // Move boundaries inward to avoid presenting partial words as source wording.
  let end = Math.min(text.length, start + budget);
  if (start && !/\s/.test(text[start - 1])) {
    const next = text.slice(start, end).search(/\s/);
    if (next >= 0) start += next + 1;
  }
  if (end < text.length && !/\s/.test(text[end])) {
    const previous = text.slice(start, end).search(/\s+\S*$/);
    if (previous >= 0) end = start + previous;
  }
  return `${start ? "... " : ""}${text.slice(start, end).trim()}${end < text.length ? " ..." : ""}`;
}
