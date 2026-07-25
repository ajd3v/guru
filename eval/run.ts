// Retrieval eval over the starter library. Queries are paraphrases, never the source
// wording, so a case only passes if retrieval worked on meaning.
//
//   node src/cli.ts starter            # build data/eval.db first (add --context to compare)
//   node eval/run.ts                   # hybrid search only, offline
//   node eval/run.ts --rerank          # adds the LLM rerank stage (needs the API/router)
import { readFileSync } from "node:fs";
import { open, search, cite, type Hit } from "../src/store.ts";
import { expandQuery, rerank } from "../src/llm.ts";

const DB = process.env.GURU_DB ?? "data/eval.db";
const useRerank = process.argv.includes("--rerank");
const useHyde = process.argv.includes("--hyde");
type Case = { query: string; expect: string; source?: string };

// Hand-written cases are the trusted reference; generated ones give the sample size needed
// to separate configurations. They are scored separately so drift between them is visible —
// if generated cases score much higher, they leaked vocabulary and the set is not measuring
// what it claims to.
const load = (f: string, source: string): Case[] => {
  try {
    return (JSON.parse(readFileSync(f, "utf8")) as Case[]).map((c) => ({ ...c, source }));
  } catch {
    return [];
  }
};
const cases = [
  ...load("eval/cases.json", "hand"),
  ...(process.argv.includes("--hand-only") ? [] : load("eval/cases.generated.json", "gen")),
];

const flat = (s: string) => s.replace(/\s+/g, " ");
const rankOf = (hits: Hit[], expect: string) =>
  hits.findIndex((h) => flat(h.text).includes(flat(expect)));

const db = open(DB);
const rows: string[] = [];
let fusedHits = 0;
let topHits = 0;
let mrr = 0;
let scored = 0;
const bySource: Record<string, { n: number; top: number }> = {};

for (const c of cases) {
  // Skip cases whose book isn't in this corpus, so the same case file works on a subset.
  const present = (db.prepare("select 1 from chunks where text like ? limit 1")
    .get(`%${c.expect.split(/\s+/).slice(0, 4).join("%")}%`)) as unknown;
  if (!present) continue;
  scored++;
  const src = c.source ?? "hand";
  bySource[src] ??= { n: 0, top: 0 };
  bySource[src].n++;

  const fused = await search(db, useHyde ? await expandQuery(c.query) : c.query);
  const inFused = rankOf(fused, c.expect);
  const final = useRerank ? await rerank(c.query, fused) : fused.slice(0, 5);
  const inTop = rankOf(final, c.expect);

  if (inFused !== -1) fusedHits++;
  if (inTop !== -1) {
    topHits++;
    bySource[src].top++;
    mrr += 1 / (inTop + 1);
  }
  rows.push(
    `${inTop !== -1 ? "PASS" : "FAIL"}  fused@20 ${String(inFused).padStart(2)}  ` +
      `top@5 ${String(inTop).padStart(2)}  ${c.query.slice(0, 46).padEnd(46)}  ` +
      `${inTop !== -1 ? cite(final[inTop]) : ""}`,
  );
}

const pct = (n: number) => `${((n / scored) * 100).toFixed(0)}%`;
if (scored <= 15 || process.argv.includes("--verbose")) console.log(rows.join("\n"));
console.log(
  `\n${scored}/${cases.length} cases in corpus · ${process.env.GURU_EMBED ?? "bge-base"}` +
    ` · ${useHyde ? "hyde + " : ""}${useRerank ? "search + rerank" : "search only"}` +
    `\nrecall@20 (fused)  ${fusedHits}/${scored}  ${pct(fusedHits)}` +
    `\nrecall@5  (final)  ${topHits}/${scored}  ${pct(topHits)}` +
    `\nMRR@5              ${(mrr / scored).toFixed(3)}` +
    `\n` +
    Object.entries(bySource)
      .map(([k, v]) => `  ${k.padEnd(5)} recall@5 ${v.top}/${v.n}  ${((v.top / v.n) * 100).toFixed(0)}%`)
      .join("\n"),
);

// recall@20 is the ceiling: rerank can only reorder what search already found.
if (topHits < scored) {
  console.log(`\nceiling check: ${fusedHits - topHits} case(s) found by search but lost by ranking`);
}
