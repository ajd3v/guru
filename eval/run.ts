// Retrieval eval over the starter library. Queries are paraphrases, never the source
// wording, so a case only passes if retrieval worked on meaning.
//
//   node src/cli.ts starter            # build data/eval.db first (add --context to compare)
//   node eval/run.ts                   # hybrid search only, offline
//   node eval/run.ts --rerank          # adds the LLM rerank stage (needs the API/router)
// Entry point, so it loads .env like the CLI does. Without this the eval would
// silently fall back to the Anthropic provider and measure a different backend
// than the one under test.
try {
  process.loadEnvFile();
} catch {
  // no .env; env vars may still be set externally
}

import { readFileSync } from "node:fs";
import { CANDIDATES, open, search, cite, type Hit } from "../src/store.ts";
import { expandQuery, rerank, stats } from "../src/llm.ts";

const DB = process.env.GURU_DB ?? "data/eval.db";
const useRerank = process.argv.includes("--rerank");
const useHyde = process.argv.includes("--hyde");
// Deep-candidate runs are slow, so --limit N scores a subset. It strides through the file
// rather than taking a prefix: the first 60 cases measured 65% where the first 120 measured
// 48%, so a prefix is not a sample of this set, it is a different and easier set.
const limitAt = process.argv.indexOf("--limit");
const LIMIT = limitAt === -1 ? Infinity : Number(process.argv[limitAt + 1]);
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
const allCases = [
  ...load("eval/cases.json", "hand"),
  ...(process.argv.includes("--hand-only") ? [] : load("eval/cases.generated.json", "gen")),
];
const stride = Number.isFinite(LIMIT) ? Math.max(1, Math.floor(allCases.length / LIMIT)) : 1;
const cases = stride > 1 ? allCases.filter((_, i) => i % stride === 0) : allCases;

const flat = (s: string) => s.replace(/\s+/g, " ");
const rankOf = (hits: Hit[], expect: string) =>
  hits.findIndex((h) => flat(h.text).includes(flat(expect)));

const db = open(DB);
const rows: string[] = [];
// Recall of the fused list at several depths. Reporting a single "recall@20" that was really
// scanning all CANDIDATES hits (60 by default) hid where the curve bends: it charged the
// reranker for every case search had only found at rank 40, and made the search half look
// better than it is. Depth is the knob, so it has to be measured as a curve, not a point.
const DEPTHS = [...new Set([5, 20, 60, 200, 500].filter((d) => d < CANDIDATES).concat(CANDIDATES))];
const fusedAt: Record<number, number> = Object.fromEntries(DEPTHS.map((d) => [d, 0]));
let topHits = 0;
let mrr = 0;
let scored = 0;
const bySource: Record<string, { n: number; top: number }> = {};

// Flattened corpus, so "is this case scoreable here?" is decided exactly the way a hit is
// judged. A LIKE pattern of the first few words matches them in order with anything in
// between, which counted 68 cases as present in a corpus that really held 41 and silently
// inflated every denominator measured on a subset.
const corpus = (db.prepare("select text from chunks").all() as any[]).map((r) => flat(r.text));

for (const c of cases) {
  if (scored >= LIMIT) break;
  const present = corpus.some((t) => t.includes(flat(c.expect)));
  if (!present) continue;
  scored++;
  const src = c.source ?? "hand";
  bySource[src] ??= { n: 0, top: 0 };
  bySource[src].n++;

  const fused = await search(db, useHyde ? await expandQuery(c.query) : c.query);
  const inFused = rankOf(fused, c.expect);
  const final = useRerank ? await rerank(c.query, fused) : fused.slice(0, 5);
  const inTop = rankOf(final, c.expect);

  if (inFused !== -1) for (const d of DEPTHS) if (inFused < d) fusedAt[d]++;
  if (inTop !== -1) {
    topHits++;
    bySource[src].top++;
    mrr += 1 / (inTop + 1);
  }
  rows.push(
    `${inTop !== -1 ? "PASS" : "FAIL"}  fused ${String(inFused).padStart(3)}  ` +
      `top@5 ${String(inTop).padStart(2)}  ${c.query.slice(0, 46).padEnd(46)}  ` +
      `${inTop !== -1 ? cite(final[inTop]) : ""}`,
  );
}

const pct = (n: number) => `${((n / scored) * 100).toFixed(0)}%`;
if (scored <= 15 || process.argv.includes("--verbose")) console.log(rows.join("\n"));
console.log(
  `\n${scored}/${cases.length} cases in corpus · ${process.env.GURU_EMBED ?? "bge-base"}` +
    ` · ${useHyde ? "hyde + " : ""}${useRerank ? "search + rerank" : "search only"}` +
    DEPTHS.map(
      (d) => `\nrecall@${String(d).padEnd(3)} (search) ${String(fusedAt[d]).padStart(3)}/${scored}  ${pct(fusedAt[d])}`,
    ).join("") +
    `\nrecall@5   (final)  ${String(topHits).padStart(3)}/${scored}  ${pct(topHits)}` +
    `\nMRR@5               ${(mrr / scored).toFixed(3)}` +
    `\n` +
    Object.entries(bySource)
      .map(([k, v]) => `  ${k.padEnd(5)} recall@5 ${v.top}/${v.n}  ${((v.top / v.n) * 100).toFixed(0)}%`)
      .join("\n"),
);

if (stats.rerankCalls) {
  const pct = ((stats.rerankFallbacks / stats.rerankCalls) * 100).toFixed(0);
  const warn = stats.rerankFallbacks / stats.rerankCalls > 0.02 ? "  <-- RESULTS NOT TRUSTWORTHY" : "";
  console.log(`\nrerank fallbacks   ${stats.rerankFallbacks}/${stats.rerankCalls}  ${pct}%${warn}`);
}

// The deepest search recall is the ceiling: rerank can only reorder what search already found.
const ceiling = fusedAt[DEPTHS[DEPTHS.length - 1]];
if (topHits < scored) {
  console.log(`\nceiling check: ${ceiling - topHits} case(s) found by search but lost by ranking`);
}
