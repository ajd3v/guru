export const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

export function monthDayIn(timezone: string, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "numeric", day: "numeric" }).formatToParts(at);
  return { month: Number(parts.find((p) => p.type === "month")?.value) - 1, day: Number(parts.find((p) => p.type === "day")?.value) };
}

/** Extract one dated entry from a book arranged by month and day. */
export function datedReading<T extends { t: string; ps: string }>(rows: T[], month: number, day: number) {
  const marker = `${MONTHS[month]} ${day}\n`;
  const next = new RegExp(`\\n(?:${MONTHS.join("|")}) \\d{1,2}\\n`);
  let best: { title: string; text: string; page: string; row: T } | undefined;
  for (const row of rows) {
    const start = row.t.indexOf(marker);
    if (start < 0 || (start > 0 && row.t[start - 1] !== "\n")) continue;
    const rest = row.t.slice(start + marker.length).split(next)[0].trim();
    const split = rest.indexOf("\n");
    if (split < 0) continue;
    const text = rest.slice(split + 1).trim();
    if (!best || text.length > best.text.length) best = { title: rest.slice(0, split), text, page: row.ps, row };
  }
  return best;
}
