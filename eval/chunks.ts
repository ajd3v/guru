import { loadCases, sampleCases, readFrozen, writeFrozen, quotesExpected } from "./corpus.ts";
import { broaden } from "../src/profile.ts";
// Chunk-size sweep. `ingest/ingest.py` calls this the single biggest retrieval lever and says
// its value should be an eval result rather than a guess, and it has never been swept since
// HyDE landed.
//
// Search only, so it costs nothing and is deterministic: no HyDE hypothetical to vary between
// runs, no rerank call. That measures the half chunk size actually acts on. If a size wins
// here it earns a full-stack run; if none does, no API spend was wasted finding that out.
//
// The trap this guards against: a gold passage has to sit inside a single chunk to be
// scoreable, and smaller chunks split some of them. Scoring each database against whatever it
// happens to contain compares different case sets and measures chunking luck. Only cases
// present in EVERY database are scored.
//
//   node eval/chunks.ts data/chunk-1000.db data/full.db data/chunk-3000.db
try {
  if (process.env.GURU_NO_DOTENV !== "1") process.loadEnvFile();
} catch {
  // no .env, and none is needed: nothing here calls a model.
}

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { open, search, CANDIDATES, type Hit } from "../src/store.ts";

const DBS = process.argv.slice(2).filter((a) => a.endsWith(".db"));
if (!DBS.length) throw new Error("usage: node eval/chunks.ts <db> <db> …");

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const load = (f: string) => {
  try {
    return JSON.parse(readFileSync(f, "utf8")) as { query: string; expect: string }[];
  } catch {
    return [];
  }
};
const cases = loadCases();

const dbs = DBS.map((path) => {
  const db = open(path);
  const corpus = (db.prepare("select text from chunks").all() as any[]).map((r) => flat(r.text));
  const chunks = (db.prepare("select count(*) n from chunks").get() as { n: number }).n;
  return { path, db, corpus, chunks };
});

// The common denominator. A case only counts if every configuration could possibly answer it.
const common = cases.filter((c) => dbs.every((d) => d.corpus.some((t) => t.includes(flat(c.expect)))));
if (!common.length) throw new Error("No evaluation cases shared by these corpora");
const perDb = dbs.map((d) => cases.filter((c) => d.corpus.some((t) => t.includes(flat(c.expect)))).length);

console.log(`\n${common.length} of ${cases.length} cases scoreable in all ${dbs.length} configurations`);
console.log(`(individually: ${dbs.map((d, i) => `${basename(d.path)} ${perDb[i]}`).join(", ")})`);
console.log(`\n${"chunk db".padEnd(22)} ${"chunks".padEnd(8)} ${"@5".padEnd(11)} ${"@20".padEnd(11)} @${CANDIDATES}`);

const DEPTHS = [5, 20, CANDIDATES];
for (const d of dbs) {
  const hits: Record<number, number> = { 5: 0, 20: 0, [CANDIDATES]: 0 };
  for (const c of common) {
    const fused: Hit[] = await search(d.db, c.query);
    const at = fused.findIndex((h) => flat(h.text).includes(flat(c.expect)));
    if (at !== -1) for (const depth of DEPTHS) if (at < depth) hits[depth]++;
  }
  const pct = (n: number) => `${n}/${common.length} ${((n / common.length) * 100).toFixed(0)}%`;
  console.log(
    `${basename(d.path).padEnd(22)} ${String(d.chunks).padEnd(8)} ` +
      DEPTHS.map((depth) => pct(hits[depth]).padEnd(11)).join(""),
  );
}
