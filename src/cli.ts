#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { addBook, cite, open, search, type Book } from "./store.ts";
import { ask as askClaude, contextualize, rerank, unverifiedQuotes } from "./llm.ts";

const PY = ".venv/bin/python";
const SIDECAR = "ingest/ingest.py";
const DB = process.env.GURU_DB ?? "data/library.db";

/** The sidecar runs in its own process because PDF parsers are an RCE surface. */
function extract(path: string, pageOffset = 0): Book {
  const args = [SIDECAR, path, ...(pageOffset ? ["--page-offset", String(pageOffset)] : [])];
  const out = execFileSync(PY, args, { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
  return JSON.parse(out);
}

function db() {
  mkdirSync(DB.replace(/\/[^/]*$/, ""), { recursive: true });
  return open(DB);
}

async function add(path: string, pageOffset: number, withContext: boolean) {
  const book = extract(path, pageOffset);
  const contexts = withContext ? await contextualize(book, book.chunks) : undefined;
  await addBook(db(), book, contexts);
  console.log(
    `added: ${book.title} — ${book.author} (${book.chunks.length} chunks` +
      `${withContext ? ", contextualized" : ""})`,
  );
}

async function find(query: string) {
  for (const hit of await rerank(query, await search(db(), query))) {
    console.log(`\n${cite(hit)}  score ${hit.score.toFixed(4)}`);
    console.log(hit.text.slice(0, 300).replace(/\n/g, " "));
  }
}

async function ask(query: string) {
  const hits = await rerank(query, await search(db(), query));
  if (!hits.length) return console.log("your library doesn't cover this.");
  const { answer, regenerated } = await askClaude(query, hits);
  console.log(answer);
  if (regenerated) console.error("\n(verifier rejected the first draft; regenerated)");
}

async function selfcheck() {
  const dir = mkdtempSync(join(tmpdir(), "guru-"));
  const pdf = execFileSync(PY, [SIDECAR, "--sample", join(dir, "Patanjali - Yoga Sutras.pdf")], {
    encoding: "utf8",
  }).trim();

  const conn = open(join(dir, "library.db"));
  await addBook(conn, extract(pdf));

  // The whole promise: ask for a known quote, get the page it is actually on.
  const hits = await search(conn, "Yoga is the stilling of the fluctuations of the mind");
  assert(hits.length, "no hits");
  const top = hits[0];
  assert(top.text.includes("stilling of the fluctuations"), `wrong top hit: ${top.text.slice(0, 80)}`);
  assert.equal(cite(top), "[Yoga Sutras, Patanjali, p. 3-4]");

  // Conceptual query, no shared keywords: the vector half has to carry it.
  const concept = await search(conn, "quieting a restless mind");
  assert(
    concept.some((h) => h.text.includes("stilling of the fluctuations")),
    "vector search did not surface the passage",
  );

  // FTS5 syntax characters must not blow up the query.
  await search(conn, 'what does "yoga" mean AND (why)?');

  // The verifier, offline: a rewrapped real quote passes, an invented one does not.
  assert.deepEqual(
    unverifiedQuotes("> Yoga is the stilling\n> of the fluctuations [x]\n\n> Be water. [y]", hits),
    ["Be water."],
  );

  console.error(`selfcheck ok: ${hits.length} hits, top ${cite(top)}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const withContext = rest.includes("--context");
const offsetAt = rest.indexOf("--page-offset");
const pageOffset = offsetAt === -1 ? 0 : Number(rest[offsetAt + 1]);
const arg = rest
  .filter((a, i) => a !== "--context" && (offsetAt === -1 || (i !== offsetAt && i !== offsetAt + 1)))
  .join(" ");

if (cmd === "add") await add(arg, pageOffset, withContext);
else if (cmd === "find") await find(arg);
else if (cmd === "ask") await ask(arg);
else if (cmd === "selfcheck") await selfcheck();
else
  console.log(
    "usage: guru add BOOK.pdf [--page-offset N] [--context] | find QUERY | ask QUESTION | selfcheck",
  );
