import { loadCases, sampleCases, readFrozen, writeFrozen, quotesExpected } from "./corpus.ts";
import { broaden } from "../src/profile.ts";
// Rerank eval: given the same candidate list, which reranker promotes the right passage?
//
// The reranker is the measured ceiling on retrieval. Search finds the answer within 60
// candidates for 72% of cases and the stack ships 60%, and feeding it a better list does not
// help, a stronger embedder raised search to 78% and shipped 59%. So the question left is
// whether the reranker itself can be made to discriminate better.
//
// Candidates are frozen to a file, because HyDE writes a different hypothetical every time and
// two rerankers compared across separate runs are graded on different candidate sets. That
// mistake reversed a model comparison earlier in this project before it was caught.
//
//   node eval/rerank.ts --cache data/rerank-cases.json --models modelA,modelB
try {
  if (process.env.GURU_NO_DOTENV !== "1") process.loadEnvFile();
} catch {
  // no .env; env vars may still be set externally
}

import { readFileSync, writeFileSync } from "node:fs";
import { open, search, type Hit } from "../src/store.ts";
import { _resetLlmConfig, expandQuery, rerank, stats } from "../src/llm.ts";

const DB = process.env.GURU_DB ?? "data/full.db";
const arg = (name: string, fallback = "") => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const CACHE = arg("--cache");
const LIMIT = Number(arg("--limit", "151"));
const MODELS = arg("--models", process.env.GURU_PIPELINE_MODEL ?? "").split(",").map((s) => s.trim());

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const load = (f: string) => {
  try {
    return JSON.parse(readFileSync(f, "utf8")) as { query: string; expect: string }[];
  } catch {
    return [];
  }
};

type Frozen = { query: string; expect: string; candidates: Hit[] };
let frozen: Frozen[] = [];
const db = open(DB);
const cases = sampleCases(loadCases(), LIMIT);
const cacheKind = `rerank:${JSON.stringify(cases)}`;
frozen = readFrozen<Frozen>(CACHE, db, cacheKind);

if (!frozen.length) {
  const all = loadCases();
  const stride = Math.max(1, Math.floor(all.length / LIMIT));
  const corpus = (db.prepare("select text from chunks").all() as any[]).map((r) => flat(r.text));

  for (const c of cases) {
    // Only cases whose answer is actually in this corpus, judged exactly the way a hit is.
    if (!corpus.some((t) => t.includes(flat(c.expect)))) continue;
    const candidates = await search(db, await expandQuery(c.query));
    // A case whose answer search never found says nothing about the reranker.
    if (!candidates.some((h) => flat(h.text).includes(flat(c.expect)))) continue;
    frozen.push({ query: c.query, expect: c.expect, candidates });
  }
  writeFrozen(CACHE, db, cacheKind, frozen);
}

console.log(`Selected ${cases.length} cases. Eligible ${frozen.length}. Excluded or missed ${cases.length - frozen.length}.`);
if (!frozen.length) throw new Error("No eligible rerank cases for this corpus");

const rankOf = (hits: Hit[], expect: string) =>
  hits.findIndex((h) => flat(h.text).includes(flat(expect)));

// What the candidate list already gives without any reranking. The reranker has to beat this
// to be worth its four calls, and reporting it stops a mediocre reranker looking like a win.
let unranked = 0;
for (const c of frozen) if (rankOf(c.candidates.slice(0, 5), c.expect) !== -1) unranked++;

console.log(`\n${frozen.length} cases where search supplied the answer, identical candidates throughout`);
console.log(`\n${"reranker".padEnd(30)} ${"recall@5".padEnd(13)} ${"MRR@5".padEnd(8)} fallbacks`);
console.log(`${"(no rerank, fused order)".padEnd(30)} ${`${unranked}/${frozen.length} ${((unranked / frozen.length) * 100).toFixed(0)}%`.padEnd(13)} ${"-".padEnd(8)} -`);

for (const model of MODELS) {
  if (model) process.env.GURU_PIPELINE_MODEL = model;
  _resetLlmConfig();
  stats.rerankCalls = 0;
  stats.rerankFallbacks = 0;

  let hits = 0;
  let mrr = 0;
  for (const c of frozen) {
    const top = await rerank(c.query, c.candidates);
    const at = rankOf(top, c.expect);
    if (at !== -1) {
      hits++;
      mrr += 1 / (at + 1);
    }
  }
  // A reranker whose output cannot be parsed degrades to the unranked order, which scores like
  // a mediocre reranker rather than like the broken upstream it is. Print it beside the score.
  const fallback = stats.rerankCalls
    ? `${stats.rerankFallbacks}/${stats.rerankCalls} ${((stats.rerankFallbacks / stats.rerankCalls) * 100).toFixed(0)}%`
    : "-";
  console.log(
    `${(model || "(default)").split("/").pop()!.padEnd(30)} ` +
      `${`${hits}/${frozen.length} ${((hits / frozen.length) * 100).toFixed(0)}%`.padEnd(13)} ` +
      `${(mrr / frozen.length).toFixed(3).padEnd(8)} ${fallback}`,
  );
}
