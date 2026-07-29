// Answer eval: given passages that DO contain the answer, does the model quote the right one?
//
// The retrieval eval scores whether the gold chunk reaches the top 5. This scores what happens
// next, and it is deliberately not an LLM judge: the cases already carry the gold passage, so
// "did the answer quote a sentence from the gold chunk" is a fact, not an opinion.
//
// Cases where retrieval missed are skipped, not failed — otherwise this measures retrieval
// again and a cheaper answer model looks bad for the search stage's reasons.
//
// Retrieval runs ONCE per case and every model answers from the same passages. Re-retrieving
// per model looked reasonable and was not: HyDE and the reranker are both stochastic, so each
// model got a different set of cases and the comparison measured luck as much as skill.
//
//   node eval/answers.ts --limit 30 --models modelA,modelB
try {
  process.loadEnvFile();
} catch {
  // no .env; env vars may still be set externally
}

import { readFileSync } from "node:fs";
import { open, search, type Hit } from "../src/store.ts";
import { _resetLlmConfig, ask, expandQuery, rerank } from "../src/llm.ts";

const DB = process.env.GURU_DB ?? "data/full.db";
const limitAt = process.argv.indexOf("--limit");
const LIMIT = limitAt === -1 ? 30 : Number(process.argv[limitAt + 1]);

type Case = { query: string; expect: string };
const load = (f: string): Case[] => {
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Case[];
  } catch {
    return [];
  }
};

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const all = [...load("eval/cases.json"), ...load("eval/cases.generated.json")];
// Stride rather than slice: the file is ordered by book, so a prefix is one author's cases.
const stride = Math.max(1, Math.floor(all.length / LIMIT));
const cases = all.filter((_, i) => i % stride === 0);

/** The verbatim sentences an answer actually quoted, citations stripped. */
const quotesOf = (answer: string) =>
  answer
    .split("\n")
    .filter((l) => l.trimStart().startsWith(">"))
    .map((l) => flat(l.replace(/^\s*>\s?/, "").replace(/\s*\[[^\]]*\]\s*$/, "")))
    .filter(Boolean);

const modelsAt = process.argv.indexOf("--models");
const MODELS =
  modelsAt === -1
    ? [process.env.GURU_ANSWER_MODEL ?? ""]
    : process.argv[modelsAt + 1].split(",").map((s) => s.trim());

const db = open(DB);
const score = Object.fromEntries(
  MODELS.map((m) => [m, { gold: 0, answered: 0, refused: 0, dropped: 0 }]),
);
let eligible = 0;

for (const c of cases) {
  const hits: Hit[] = await rerank(c.query, await search(db, await expandQuery(c.query)));

  // Only score what the answer model was actually given a chance at. A case retrieval missed
  // says nothing about the answer step, and counting it as a failure re-measures search.
  const gold = hits.find((h) => flat(h.text).includes(flat(c.expect)));
  if (!gold) continue;
  eligible++;
  const goldText = flat(gold.text);

  for (const model of MODELS) {
    // `ask` reads the resolved model once and caches it, so the cache has to be dropped
    // between models or every row after the first is answered by the first model.
    if (model) process.env.GURU_ANSWER_MODEL = model;
    _resetLlmConfig();

    const result = await ask(c.query, hits);
    const quotes = quotesOf(result.answer);
    const s = score[model];
    if (quotes.length) s.answered++;
    else s.refused++;
    if (quotes.some((q) => goldText.includes(q))) s.gold++;
    s.dropped += result.dropped;
  }
}

const pct = (n: number) => (eligible ? `${((n / eligible) * 100).toFixed(0)}%` : "n/a");
console.log(`\n${eligible}/${cases.length} cases where retrieval supplied the answer, same passages for every model\n`);
console.log(`${"model".padEnd(34)} ${"cited gold".padEnd(12)} ${"refused".padEnd(10)} dropped`);
for (const m of MODELS) {
  const s = score[m];
  console.log(
    `${(m || "(provider default)").padEnd(34)} ` +
      `${`${s.gold}/${eligible} ${pct(s.gold)}`.padEnd(12)} ` +
      // A refusal here is a false negative: the passage that answers the question was on the
      // model's desk. It is the failure mode a cheaper model is most likely to introduce.
      `${`${s.refused} ${pct(s.refused)}`.padEnd(10)} ${s.dropped}`,
  );
}
