// Paired local retrieval checks. No model endpoint is used.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { loadCases, readCases, sampleCases, corpusIdentity, caseSplit } from "./corpus.ts";
import { listBooks, open, search, CANDIDATES, VECTOR_WEIGHT } from "../src/store.ts";
import { broaden, profile, ENGINE_ROOT } from "../src/profile.ts";
import { excerpt } from "../src/excerpt.ts";
import { DIM, MODEL_ID, embed } from "../src/embed.ts";

const arg = (name: string, fallback = "") => {
  const at = process.argv.indexOf(name);
  if (at >= 0 && (!process.argv[at + 1] || process.argv[at + 1].startsWith("--"))) throw new Error(`${name} requires a value`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const sourceCases = arg("--source-cases");
const mode = sourceCases ? "source-selection" : "weighted-search";
const split = arg("--split", "all");
if (!["dev", "holdout", "all"].includes(split)) throw new Error("Split must be dev, holdout, or all");
const baselineWeight = Number(arg("--baseline-weight", sourceCases ? String(VECTOR_WEIGHT) : "1"));
const candidateWeight = Number(arg("--candidate-weight", String(VECTOR_WEIGHT)));
const inputCases = sourceCases ? readCases(sourceCases, "source-selection") : loadCases();
if (sourceCases && inputCases.some((c) => !c.scope)) throw new Error("Source-selection cases require a title and author scope");
const cases = sampleCases(inputCases.filter((c) => split === "all" || caseSplit(c) === split), Number(arg("--limit", "Infinity")));
const engineHash = createHash("sha256");
for (const directory of ["src", "eval"]) {
  for (const file of readdirSync(join(ENGINE_ROOT, directory)).filter((f) => f.endsWith(".ts")).sort()) {
    engineHash.update(`${directory}/${file}\0`).update(readFileSync(join(ENGINE_ROOT, directory, file)));
  }
}
engineHash.update(readFileSync(join(ENGINE_ROOT, "package-lock.json")));
let revision: string | null = null;
try { revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ENGINE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
const db = open(process.env.GURU_DB ?? "data/eval.db");
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
try {
  const indexHash = createHash("sha256");
  for (const row of db.prepare("select rowid, text from chunks_fts order by rowid").iterate()) indexHash.update(JSON.stringify(row));
  for (const row of db.prepare("select rowid, embedding from chunks_vec order by rowid").iterate() as Iterable<{ rowid: number; embedding: Buffer }>) {
    indexHash.update(String(row.rowid) + "\0").update(row.embedding);
  }
  // Keep model initialization outside both search timings.
  await embed(["retrieval evaluation warmup"], "query");
  const corpus = db.prepare("select id, book_id, text from chunks").all() as { id: number; book_id: number; text: string }[];
  const books = listBooks(db);
  const rows: { query: string; source?: string; split: string; excluded: boolean; excludedReason: string; bookId?: number; baselineRank: number; candidateRank: number; prefixVisible: boolean; excerptVisible: boolean }[] = [];
  const summaries = [baselineWeight, candidateWeight].map((vectorWeight, index) => ({ vectorWeight, preview: index || sourceCases ? "excerpt" : "prefix", hit5: 0, hitCandidates: 0, visible5: 0, visibleCandidates: 0, mrr5: 0, searchMs: 0 }));
  let eligible = 0;
  let prefixVisible = 0;
  let excerptVisible = 0;
  let visibilityGained = 0;
  let visibilityLost = 0;
  let sourceViolations = 0;
  for (const c of cases) {
    const selected = sourceCases ? books.filter((b) => b.title === c.scope!.title && b.author === c.scope!.author) : [];
    const bookId = selected.length === 1 ? selected[0].id : undefined;
    const gold = corpus.filter((r) => (!sourceCases || r.book_id === bookId) && flat(r.text).includes(flat(c.expect)));
    const excludedReason = sourceCases && selected.length !== 1 ? (selected.length ? "ambiguous source" : "missing source") : !gold.length ? "expected span absent" : "";
    const row = { query: c.query, source: c.source, split: caseSplit(c), excluded: !!excludedReason, excludedReason, bookId, baselineRank: -1, candidateRank: -1, prefixVisible: false, excerptVisible: false };
    rows.push(row);
    if (row.excluded) continue;
    eligible++;
    const ids = new Set(gold.map((r) => r.id));
    row.prefixVisible = gold.some((r) => flat(r.text.slice(0, 700)).includes(flat(c.expect)));
    row.excerptVisible = gold.some((r) => flat(excerpt(r.text, c.query, 700)).includes(flat(c.expect)));
    prefixVisible += Number(row.prefixVisible);
    excerptVisible += Number(row.excerptVisible);
    visibilityGained += Number(row.excerptVisible && !row.prefixVisible);
    visibilityLost += Number(row.prefixVisible && !row.excerptVisible);
    // Alternate search order after warming the model.
    for (const index of eligible % 2 ? [0, 1] : [1, 0]) {
      const started = performance.now();
      const hits = await search(db, broaden(c.query), CANDIDATES, {
        vectorWeight: summaries[index].vectorWeight, exactPhrases: !!sourceCases || index === 1,
        literalQuery: c.query, bookIds: sourceCases && index === 1 ? [bookId!] : undefined,
      });
      const rank = hits.findIndex((h) => ids.has(h.id));
      summaries[index].searchMs += performance.now() - started;
      if (sourceCases && index === 1) sourceViolations += hits.filter((h) => h.book_id !== bookId).length;
      const visibleRank = hits.findIndex((h) => ids.has(h.id) && flat(index || sourceCases ? excerpt(h.text, c.query, 700) : h.text.slice(0, 700)).includes(flat(c.expect)));
      if (visibleRank >= 0) summaries[index].visibleCandidates++;
      if (visibleRank >= 0 && visibleRank < 5) summaries[index].visible5++;
      if (rank >= 0) summaries[index].hitCandidates++;
      if (rank >= 0 && rank < 5) { summaries[index].hit5++; summaries[index].mrr5 += 1 / (rank + 1); }
      if (index === 0) row.baselineRank = rank;
      else row.candidateRank = rank;
    }
  }
  const result = {
    profile: profile.id, identity: { ...corpusIdentity(db), ...(sourceCases ? { cases: createHash("sha256").update(readFileSync(sourceCases)).digest("hex") } : {}) }, mode, split, selected: cases.length,
    engine: { baseRevision: revision, filesHash: engineHash.digest("hex"), method: "weighted-rrf-source-filter-v2" },
    embedding: { model: MODEL_ID, dimensions: DIM }, runtime: process.version,
    indexes: indexHash.digest("hex"),
    eligible, excluded: cases.length - eligible, candidates: CANDIDATES,
    baseline: summaries[0], candidate: summaries[1],
    ...(sourceCases ? { sourceViolations } : {}),
    visibility: { budget: 700, prefix: prefixVisible, excerpt: excerptVisible, gained: visibilityGained, lost: visibilityLost }, rows,
  };
  for (const s of summaries) s.mrr5 = eligible ? s.mrr5 / eligible : 0;
  const output = arg("--output");
  if (output) writeFileSync(output, JSON.stringify(result, null, 2));
  if (!eligible) throw new Error(`No eligible cases. Selected ${cases.length}, excluded ${result.excluded}.`);
  if (sourceViolations) throw new Error(`${sourceViolations} results escaped the selected source`);
  console.log(`${profile.id}: ${eligible}/${cases.length} eligible, ${result.excluded} excluded, split ${split}, mode ${mode}`);
  for (const [label, s] of [["baseline", summaries[0]], ["candidate", summaries[1]]] as const) {
    console.log(`${label}: recall@5 ${s.hit5}/${eligible}, recall@${CANDIDATES} ${s.hitCandidates}/${eligible}, MRR@5 ${s.mrr5.toFixed(3)}`);
  }
  console.log(`Expected span visible in 700 characters: prefix ${prefixVisible}/${eligible}, excerpt ${excerptVisible}/${eligible}`);
} finally { db.close(); }
