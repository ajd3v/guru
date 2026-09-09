import { loadCases, sampleCases, readFrozen, writeFrozen, quotesExpected } from "./corpus.ts";
import { broaden } from "../src/profile.ts";
// Answer eval: given passages that DO contain the answer, does the model quote the right one?
//
// The retrieval eval scores whether the gold chunk reaches the top 5. This scores what happens
// next, and it is deliberately not an LLM judge: the cases already carry the gold passage, so
// "did the answer quote a sentence from the gold chunk" is a fact, not an opinion.
//
// Cases where retrieval missed are skipped, not failed. Otherwise this measures retrieval
// again and a cheaper answer model looks bad for the search stage's reasons.
//
// Retrieval runs ONCE per case and every model answers from the same passages. Re-retrieving
// per model looked reasonable and was not: HyDE and the reranker are both stochastic, so each
// model got a different set of cases and the comparison measured luck as much as skill.
//
//   node eval/answers.ts --limit 30 --models modelA,modelB
try {
  if (process.env.GURU_NO_DOTENV !== "1") process.loadEnvFile();
} catch {
  // no .env; env vars may still be set externally
}

import { readFileSync, writeFileSync } from "node:fs";
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
const all = loadCases();
// Stride rather than slice: the file is ordered by book, so a prefix is one author's cases.
const stride = Math.max(1, Math.floor(all.length / LIMIT));
const cases = sampleCases(all, LIMIT);

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

/** `ask` returns this when every quote failed verification. Distinct from a model decline. */
const UNGROUNDED = "Your library has passages near this";

const db = open(DB);
const score = Object.fromEntries(
  // `dropped` was one number covering two unrelated failures, and it hid three verifier bugs
  // for most of this project's life: movements in it read as the model misbehaving when the
  // checker was the thing at fault. Reported apart, `rejected` is ours to fix and `invented`
  // is the model's, and only the first should ever be zero.
  MODELS.map((m) => [m, { gold: 0, answered: 0, declined: 0, ungrounded: 0, invented: 0, rejected: 0 }]),
);
let eligible = 0;
const notes: string[] = [];

/**
 * Retrieval is stochastic, so two runs grade two different sets of cases, which makes a
 * before/after comparison of a prompt change meaningless in exactly the way comparing two
 * models across separate runs was. Freeze the passages to a file and every later run answers
 * from identical input. It also makes iterating cheap: retrieval is most of the wall clock.
 *
 *   node eval/answers.ts --cache data/answer-cases.json --limit 30
 */
const cacheAt = process.argv.indexOf("--cache");
const CACHE = cacheAt === -1 ? "" : process.argv[cacheAt + 1];
type Frozen = { query: string; expect: string; hits: Hit[] };
let frozen: Frozen[] = [];

const cacheKind = `answers:${JSON.stringify(cases)}`;
frozen = readFrozen<Frozen>(CACHE, db, cacheKind);
if (frozen.length) console.error(`Loaded ${frozen.length} frozen answer cases`);

if (!frozen.length) {
  for (const c of cases) {
    const hits: Hit[] = await rerank(c.query, await search(db, await expandQuery(c.query), undefined, { literalQuery: c.query }));
    if (hits.some((h) => flat(h.text).includes(flat(c.expect)))) {
      frozen.push({ query: c.query, expect: c.expect, hits });
    }
  }
  writeFrozen(CACHE, db, cacheKind, frozen);
}

console.log(`Selected ${cases.length} cases. Eligible ${frozen.length}. Excluded or missed ${cases.length - frozen.length}.`);
if (!frozen.length) throw new Error("No eligible answer cases for this corpus");

for (const c of frozen) {
  const hits = c.hits;

  // Only score what the answer model was actually given a chance at. A case retrieval missed
  // says nothing about the answer step, and counting it as a failure re-measures search.
  const gold = hits.find((h) => flat(h.text).includes(flat(c.expect)))!;
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
    s.invented += result.invented;
    s.rejected += result.rejected;

    if (quotes.length) {
      s.answered++;
      if (quotesExpected(result.answer, c.expect)) s.gold++;
      else notes.push(`  miss  ${model.split("/").pop()}  ${c.query.slice(0, 62)}`);
      continue;
    }

    // Two very different failures, and lumping them together hides which to fix. A decline
    // is the model's judgement about passages it was shown. Ungrounded means it answered and
    // every quote failed verification, which should be near-impossible: the quoted text is
    // spliced from those same passages, so it is a bug rather than a judgement call.
    const ungrounded = !result.declined && !quotes.length;
    if (ungrounded) s.ungrounded++;
    else s.declined++;
    notes.push(
      `  ${ungrounded ? "UNGROUNDED" : "declined  "}  ${model.split("/").pop()}  ${c.query.slice(0, 62)}`,
    );
  }
}

const pct = (n: number) => (eligible ? `${((n / eligible) * 100).toFixed(0)}%` : "n/a");
console.log(`\n${eligible} cases where retrieval supplied the answer, identical passages throughout\n`);
console.log(`${"model".padEnd(30)} ${"cited gold".padEnd(12)} ${"declined".padEnd(10)} ${"ungrounded".padEnd(11)} ${"rejected".padEnd(9)} invented`);
for (const m of MODELS) {
  const s = score[m];
  console.log(
    `${(m || "(provider default)").split("/").pop()!.padEnd(30)} ` +
      `${`${s.gold}/${eligible} ${pct(s.gold)}`.padEnd(12)} ` +
      // Declining here is a false negative: the passage that answers the question was on the
      // model's desk, and the reader cannot tell that from a library that truly lacks it.
      `${`${s.declined} ${pct(s.declined)}`.padEnd(10)} ` +
      // rejected: quotes the verifier threw out, which should be zero.
      // invented: sentence ids the model made up, which is the model's error to own.
      `${`${s.ungrounded} ${pct(s.ungrounded)}`.padEnd(11)} ${String(s.rejected).padEnd(9)} ${s.invented}`,
  );
}
if (notes.length) console.log(`\n${notes.join("\n")}`);
