// Full Ask evaluation. Retrieval misses stay in the denominator. Dry-run by default.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCases, readCases, sampleCases, corpusIdentity, caseSplit, readFrozen, writeFrozen } from "./corpus.ts";
import { CANDIDATES, listBooks, open, type Hit } from "../src/store.ts";
import { ENGINE_ROOT, profile } from "../src/profile.ts";
import { ask, expandQuery, modelConfiguration } from "../src/llm.ts";
import { retrieveQuestion } from "../src/retrieval.ts";
const arg = (name: string, fallback = "") => { const i = process.argv.indexOf(name); if (i >= 0 && (!process.argv[i + 1] || process.argv[i + 1].startsWith("--"))) throw new Error(`${name} requires a value`); return i < 0 ? fallback : process.argv[i + 1]; };
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const method = arg("--method", "expanded");
if (!["expanded", "paired"].includes(method)) throw new Error("Unknown retrieval method");
const split = arg("--split", "all");
if (!["all", "dev", "holdout"].includes(split)) throw new Error("Unknown split");
const context = process.argv.includes("--context");
const supported = sampleCases((arg("--cases") ? readCases(arg("--cases")) : loadCases()).filter((c) => split === "all" || caseSplit(c) === split), Number(arg("--limit", "Infinity")));
const unsupported = arg("--unsupported") ? JSON.parse(readFileSync(arg("--unsupported"), "utf8")) : [];
if (!Array.isArray(unsupported) || unsupported.some((c) => !c || typeof c.query !== "string" || !c.query.trim() || typeof c.reason !== "string" || !c.reason.trim())) throw new Error("Unsupported cases require a question and a reason");
const db = open(process.env.GURU_DB ?? "data/eval.db");
try {
  const books = listBooks(db);
  const corpus = db.prepare("select c.id, c.book_id, c.text from chunks c").all() as { id: number; book_id: number; text: string }[];
  const rows = [...supported.map((c) => {
    const scope = c.scope ? books.filter((b) => b.title === c.scope!.title && b.author === c.scope!.author) : undefined;
    const gold = corpus.filter((r) => (!scope || scope.some((b) => b.id === r.book_id)) && flat(r.text).includes(flat(c.expect))).map((r) => r.id);
    return { ...c, kind: "supported", bookIds: scope?.map((b) => b.id), gold, excluded: scope && scope.length !== 1 ? "missing or ambiguous source" : gold.length ? "" : "expected span absent" };
  }), ...unsupported.map((c) => ({ ...c, kind: "unsupported", gold: [], excluded: "" }))] as any[];
  const eligible = rows.filter((r) => !r.excluded);
  const fileHash = createHash("sha256");
  for (const dir of ["src", "eval"]) for (const name of readdirSync(join(ENGINE_ROOT, dir)).filter((f) => f.endsWith(".ts")).sort()) fileHash.update(`${dir}/${name}\0`).update(readFileSync(join(ENGINE_ROOT, dir, name)));
  fileHash.update(readFileSync(join(ENGINE_ROOT, "package-lock.json")));
  let revision = "unknown";
  try { revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ENGINE_ROOT, encoding: "utf8" }).trim(); } catch {}
  const maxChunk = Math.max(0, ...corpus.map((r) => Buffer.byteLength(r.text)));
  const perCaseInput = 12000 + (CANDIDATES + Math.ceil(CANDIDATES / 20) * 5) * (Number(process.env.GURU_SNIPPET || 700) * 4 + 500) + maxChunk * (context ? 15 : 5);
  const perCaseOutput = 1200 + (Math.ceil(CANDIDATES / 20) + 1) * 200;
  const priceIn = Number(arg("--input-price", "NaN")), priceOut = Number(arg("--output-price", "NaN"));
  const validPrices = Number.isFinite(priceIn) && priceIn >= 0 && Number.isFinite(priceOut) && priceOut >= 0;
  const estimate = { callsPerCaseAtMost: Math.ceil(CANDIDATES / 20) + 3, inputTokenAllowance: perCaseInput * eligible.length, outputTokenAllowance: perCaseOutput * eligible.length,
    retryAllowance: 3, dollarsWithRetryAllowance: validPrices ? eligible.length * 3 * (perCaseInput * priceIn + perCaseOutput * priceOut) / 1e6 : null,
    note: "Conservative planning estimate, not a billing guarantee. Prices must cover both configured models. Check provider pricing and retries before --run." };
  const report: any = { version: 1, at: new Date().toISOString(), profile: profile.id, identity: corpusIdentity(db), casesHash: createHash("sha256").update(JSON.stringify(rows)).digest("hex"), engine: { revision, filesHash: fileHash.digest("hex") }, models: modelConfiguration(), configuration: { candidates: CANDIDATES, method, context, split }, selected: rows.length, eligible: eligible.length, excluded: rows.filter((r) => r.excluded).map((r) => ({ query: r.query, reason: r.excluded })), estimate, rows: [] };
  console.log(JSON.stringify({ selected: report.selected, eligible: report.eligible, excluded: report.excluded, models: report.models, estimate }, null, 2));
  if (process.argv.includes("--run")) {
    const budget = Number(arg("--budget", "NaN"));
    if (!validPrices || !Number.isFinite(budget) || budget < estimate.dollarsWithRetryAllowance!) throw new Error("Provide current --input-price and --output-price per million tokens and a --budget covering the planning estimate");
    if (!arg("--output")) throw new Error("A full run requires --output to preserve review evidence");
    const expansionFile = arg("--freeze-expansions");
    const expansionKind = "pipeline-expansions:" + JSON.stringify(modelConfiguration()) + createHash("sha256").update(readFileSync(join(ENGINE_ROOT, "src/llm.ts"))).digest("hex");
    const expansions = readFrozen<{ query: string; expanded: string }>(expansionFile, db, expansionKind);
    for (const c of eligible) {
      const started = performance.now();
      try {
        let expanded = expansions.find((row) => row.query === c.query)?.expanded;
        if (expanded === undefined) {
          expanded = await expandQuery(c.query);
          expansions.push({ query: c.query, expanded });
          writeFrozen(expansionFile, db, expansionKind, expansions);
        }
        const expansionMs = performance.now() - started;
        const retrieval = await retrieveQuestion(db, c.query, { bookIds: c.bookIds, method: method as "expanded" | "paired", context, expanded });
        const answerStarted = performance.now();
        const result = await ask(c.query, retrieval.hits);
        const answerMs = performance.now() - answerStarted;
        const isGold = (hits: Hit[]) => hits.some((h) => c.gold.includes(h.id));
        const quotes = result.passages.map((p) => {
          const source = db.prepare("select c.text, c.page_start, c.page_end, b.title, b.author, b.revision from chunks c join books b on b.id = c.book_id where c.id = ? and c.book_id = ?").get(p.hit.id, p.hit.book_id) as any;
          return { text: p.text, book: p.hit.book_id, revision: p.hit.revision, chunk: p.hit.id, title: p.hit.title, author: p.hit.author, pageStart: p.hit.page_start, pageEnd: p.hit.page_end,
            verbatim: !!source && flat(source.text).includes(flat(p.text)), citationValid: !!source && source.title === p.hit.title && source.author === p.hit.author && source.revision === p.hit.revision && String(source.page_start) === String(p.hit.page_start) && String(source.page_end) === String(p.hit.page_end) };
        });
        report.rows.push({ query: c.query, kind: c.kind, expected: c.expect, unsupportedReason: c.reason, expanded: retrieval.expanded, candidateGold: isGold(retrieval.groups.flatMap((g) => g.candidates)), rankedGold: isGold(retrieval.ranked), answerContextGold: isGold(retrieval.hits), quotedExpected: c.expect ? quotes.some((q) => flat(q.text).includes(flat(c.expect))) : false,
          declined: result.declined, emptyWithoutDecline: !result.declined && !quotes.length, quotes, synopsis: result.synopsis, inventedIds: result.invented, elapsedMs: performance.now() - started, stages: { expansionMs, answerMs, groups: retrieval.groups.map((g) => ({ candidates: g.candidates.length, ranked: g.ranked.length, searchMs: g.searchMs, rerankMs: g.rerankMs })) }, supportReview: { status: "unreviewed", supportsQuestion: null, missingCaveat: null, note: "Verbatim wording and gold matching do not establish that an answer supports the question. Review quotations in their source context." } });
      } catch (error) { report.rows.push({ query: c.query, kind: c.kind, error: error instanceof Error ? error.message : String(error) }); }
      writeFileSync(arg("--output"), JSON.stringify(report, null, 2));
    }
    const good = report.rows.filter((r: any) => r.kind === "supported"), bad = report.rows.filter((r: any) => r.kind === "unsupported");
    report.scores = { supported: { denominator: good.length, candidateGold: good.filter((r: any) => r.candidateGold).length, quotedExpected: good.filter((r: any) => r.quotedExpected).length, falseDeclines: good.filter((r: any) => r.declined).length }, unsupported: { denominator: bad.length, declined: bad.filter((r: any) => r.declined).length, answered: bad.filter((r: any) => r.quotes?.length).length }, errors: report.rows.filter((r: any) => r.error).length, supportReview: "pending" };
    console.log(JSON.stringify(report.scores, null, 2));
  }
  if (arg("--output")) writeFileSync(arg("--output"), JSON.stringify(report, null, 2));
} finally { db.close(); }
