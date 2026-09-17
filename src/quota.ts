import type Database from "better-sqlite3";

export const INITIAL_ASKS = 5;
export const DAILY_ASKS = 5;
type Counter = { used: number; trial_ended: string | null; day: string; daily_used: number };
export type Allowance = { remaining: number; phase: "initial" | "daily"; resetAt: string };
export type Bucket = { key: string; scale?: number; seed?: Partial<Counter> };
const dayOf = (now: Date) => now.toISOString().slice(0, 10);
const nextDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

export function initAllowances(db: Database.Database) {
  db.exec("create table if not exists ask_allowance (key text primary key, used integer not null, trial_ended text, day text not null, daily_used integer not null)");
}
function counter(db: Database.Database, bucket: Bucket, now: Date): Counter {
  db.prepare("insert or ignore into ask_allowance values (?, ?, ?, ?, ?)").run(bucket.key, bucket.seed?.used ?? 0, bucket.seed?.trial_ended ?? null, bucket.seed?.day ?? dayOf(now), bucket.seed?.daily_used ?? 0);
  return db.prepare("select used, trial_ended, day, daily_used from ask_allowance where key = ?").get(bucket.key) as Counter;
}
function state(row: Counter, scale: number, now: Date): Allowance {
  if (row.used < INITIAL_ASKS * scale) return { remaining: INITIAL_ASKS * scale - row.used, phase: "initial", resetAt: nextDay(now) };
  return { remaining: row.trial_ended === dayOf(now) ? 0 : Math.max(0, DAILY_ASKS * scale - (row.day === dayOf(now) ? row.daily_used : 0)), phase: "daily", resetAt: nextDay(now) };
}
export function readAllowance(db: Database.Database, bucket: Bucket, now = new Date()) {
  return state(counter(db, bucket, now), bucket.scale ?? 1, now);
}
/** Reserve all counters together before starting model work. A refusal spends nothing. */
export function reserveAsk(db: Database.Database, buckets: Bucket[], now = new Date()) {
  return db.transaction(() => {
    const rows = buckets.map((bucket) => counter(db, bucket, now));
    const states = rows.map((row, i) => state(row, buckets[i].scale ?? 1, now));
    const blocked = states.findIndex((s) => s.remaining === 0);
    if (blocked >= 0) return { allowed: false, network: blocked > 0, allowance: states[0] };
    for (const [i, row] of rows.entries()) {
      const limit = INITIAL_ASKS * (buckets[i].scale ?? 1);
      const initial = row.used < limit;
      db.prepare("update ask_allowance set used = ?, trial_ended = ?, day = ?, daily_used = ? where key = ?").run(
        row.used + 1, initial && row.used + 1 === limit ? dayOf(now) : row.trial_ended,
        dayOf(now), initial ? 0 : (row.day === dayOf(now) ? row.daily_used : 0) + 1, buckets[i].key,
      );
    }
    return { allowed: true, network: false, allowance: readAllowance(db, buckets[0], now) };
  }).immediate();
}
/** Preserve usage recorded before this policy, including existing readers already past five. */
export function accountSeed(library: Database.Database, now = new Date()): Partial<Counter> {
  const used = (library.prepare("select count(*) n from asks").get() as { n: number }).n;
  const fifth = library.prepare("select substr(at,1,10) day from asks order by at,id limit 1 offset ?").get(INITIAL_ASKS - 1) as { day: string } | undefined;
  const daily = library.prepare("select count(*) n from asks where substr(at,1,10) = ?").get(dayOf(now)) as { n: number };
  return { used, trial_ended: fifth?.day ?? null, day: dayOf(now), daily_used: fifth?.day === dayOf(now) ? 0 : daily.n };
}
export function allowanceText(value: Allowance) {
  return value.phase === "initial" ? `${value.remaining} of ${INITIAL_ASKS} initial Ask requests left. Then ${DAILY_ASKS} per day.` : `${value.remaining} of ${DAILY_ASKS} Ask requests left today. Resets at 00:00 UTC.`;
}
