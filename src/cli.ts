#!/usr/bin/env node
// ESM hoists imports, so this runs AFTER ./llm.ts is evaluated. That is fine
// because llm.ts resolves its provider on first use rather than at module scope.
// Optional by design: the pipeline runs against a local router with no .env.
try {
  if (process.env.GURU_NO_DOTENV !== "1") process.loadEnvFile();
} catch {
  // no .env, or a runtime without loadEnvFile. Env vars may still be set externally
}

import { profile, PYTHON as PY, SIDECAR, broaden } from "./profile.ts";
import { excerpt } from "./excerpt.ts";
import { fetchStarter } from "./starter.ts";
export { fetchStarter } from "./starter.ts";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { addBook, askedToday, bookPdf, cite, listBooks, open, recordAsk, search, selectedBook, userLibrary, type Book } from "./store.ts";
import {
  claim,
  countActive,
  enqueue as enqueueJob,
  finish,
  listJobs,
  openJobs,
  requeueStale,
} from "./jobs.ts";
import { ask as askLlm, contextualize, expandQuery, rerank, unverifiedQuotes } from "./llm.ts";

const DB = process.env.GURU_DB ?? "data/library.db";

/** The sidecar runs in its own process because PDF parsers are an RCE surface. */
function extract(path: string, pageOffset = 0): Book {
  const args = [SIDECAR, path, ...(pageOffset ? ["--page-offset", String(pageOffset)] : [])];
  const out = execFileSync(PY, args, { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
  return { ...JSON.parse(out), page_offset: pageOffset };
}

/** The source PDF's own bytes, kept alongside the extracted text so pages can be streamed
 * on demand later (see server.ts's /pdf-page). EPUBs have no page images, so undefined. */
function pdfBytes(path: string): Buffer | undefined {
  return path.toLowerCase().endsWith(".pdf") ? readFileSync(path) : undefined;
}

function db() {
  mkdirSync(DB.replace(/\/[^/]*$/, ""), { recursive: true });
  return open(DB);
}

async function add(path: string, pageOffset: number, withContext: boolean, metadata?: { title: string; author: string; source: string }) {
  // A directory is a bulk ingest, in this one process: loading the embedder costs more
  // than embedding a whole book, so 2,000 files must not mean 2,000 process starts.
  if (statSync(path).isDirectory()) {
    const files = readdirSync(path)
      .filter((f) => /\.(pdf|epub)$/i.test(f))
      .sort();
    let done = 0;
    for (const f of files) {
      // One unparseable file must not abandon the other 1,999.
      try {
        await add(join(path, f), pageOffset, withContext);
      } catch (err) {
        console.error(`failed ${f}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      }
      if (++done % 50 === 0) console.error(`  ${done}/${files.length}`);
    }
    return;
  }
  const book = { ...extract(path, pageOffset), ...metadata };
  const contexts = withContext ? await contextualize(book, book.chunks) : undefined;
  await addBook(db(), book, contexts, pdfBytes(path));
  console.log(
    `added: ${book.title}, ${book.author} (${book.chunks.length} chunks` +
      `${withContext ? ", contextualized" : ""})`,
  );
}

async function starter(withContext: boolean, limit = Infinity) {
  const paths = await fetchStarter(limit);
  let done = 0;
  for (const { path, pageOffset, metadata } of paths) {
    await add(path, pageOffset, withContext, metadata);
    // A shelf this size is long enough that silence reads as a hang. The count is the only way
    // to tell "still working" from "stuck on a book that will not parse".
    console.error(`  ${++done}/${paths.length} books`);
  }
}

/** Ask adds model query expansion and reranking to the local search. */
async function retrieve(query: string, selection?: string) {
  const conn = db();
  try {
    const book = selectedBook(conn, selection);
    return await rerank(query, await search(conn, await expandQuery(query), undefined, { literalQuery: query, bookIds: book ? [book.id] : undefined }));
  } finally { conn.close(); }
}

async function find(query: string, selection?: string) {
  const conn = db();
  try {
    const book = selectedBook(conn, selection);
    for (const hit of (await search(conn, broaden(query), undefined, { literalQuery: query, bookIds: book ? [book.id] : undefined })).slice(0, 8)) {
      console.log(`\n${cite(hit)}  score ${hit.score.toFixed(4)}`);
      console.log(excerpt(hit.text, query, 500).replace(/\n/g, " "));
    }
  } finally { conn.close(); }
}

async function ask(query: string, selection?: string) {
  const hits = await retrieve(query, selection);
  if (!hits.length) return console.log("your library doesn't cover this.");
  const { answer, synopsis, regenerated, dropped } = await askLlm(query, hits);
  if (synopsis) console.log(`${synopsis}\n`);
  console.log(answer);
  if (dropped) console.error(`\n(${dropped} claim(s) dropped: quotes could not be verified)`);
  else if (regenerated) console.error("\n(verifier rejected the first draft; regenerated)");
}

/**
 * Drains the ingest queue, one book at a time, in its own process.
 *
 * Separate from the server on purpose: `extract` blocks on a synchronous subprocess and
 * embedding a book is minutes of CPU, either of which would stall every other reader's
 * request if it ran on the server's event loop. The process boundary around the PDF parser
 * is also the security boundary. See the sidecar note in `extract`.
 */
async function worker() {
  const queue = openJobs();
  const stale = requeueStale(queue);
  if (stale) console.error(`requeued ${stale} job(s) left running by a previous worker`);

  for (;;) {
    const job = claim(queue);
    if (!job) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    try {
      const book = extract(job.path);
      // The sidecar names the source after the file it read, which here is a generated
      // upload path that is unique every time, so re-uploading a book would add a second
      // copy instead of replacing the first. Key on what the reader actually sent.
      await addBook(userLibrary(job.user_id), { ...book, source: job.filename }, undefined, pdfBytes(job.path));
      finish(queue, job.id);
      console.error(`ingested ${book.title} for ${job.user_id} (${book.chunks.length} chunks)`);
    } catch (err) {
      // A book that cannot be parsed is the reader's problem to see, not a crash: record it
      // against the job so the shelf can say so, and keep draining the queue.
      finish(queue, job.id, err instanceof Error ? err.message.slice(0, 300) : String(err));
      console.error(`failed ${job.filename} for ${job.user_id}:`, err);
    } finally {
      // The upload is consumed either way; leaving it costs disk and holds a copy of the
      // reader's book outside their library.
      rmSync(job.path, { force: true });
    }
  }
}

async function selfcheck() {
  const dir = mkdtempSync(join(tmpdir(), "guru-"));
  const pdf = execFileSync(PY, [SIDECAR, "--sample", join(dir, "Patanjali - Yoga Sutras.pdf")], {
    encoding: "utf8",
  }).trim();

  const conn = open(join(dir, "library.db"));
  await addBook(conn, extract(pdf), undefined, readFileSync(pdf));

  // The source PDF travels with the book, for on-demand page streaming (see /pdf-page).
  assert.deepEqual(bookPdf(conn, "Yoga Sutras")?.pdf, readFileSync(pdf));
  assert.equal(bookPdf(conn, "no such book"), undefined);

  // The whole promise: ask for a known quote, get the page it is actually on.
  const hits = await search(conn, "Yoga is the stilling of the fluctuations of the mind");
  assert(hits.length, "no hits");
  const top = hits[0];
  assert(top.text.includes("stilling of the fluctuations"), `wrong top hit: ${top.text.slice(0, 80)}`);
  assert.equal(cite(top), "[Patanjali, Yoga Sutras, p. 3-4]");

  // Unpaginated sources cite chapter and paragraph, and EPUB chapter titles arrive wrapped.
  // A locator must stay on one line or it renders half inside the blockquote.
  assert.equal(
    cite({ ...top, paginated: 0, page_start: 'Lectures VI And VII. The "Sick\n Soul.",' } as any),
    "[Patanjali, Yoga Sutras, Lectures VI And VII. The Sick Soul.]",
  );

  // Gutenberg separates a chapter number from its title with a doubled em-dash, which put a
  // typographic scar in the line under every Montaigne quotation. A comma is what it meant.
  assert.equal(
    cite({ ...top, paginated: 0, page_start: "CHAPTER XIX——THAT TO STUDY PHILOSOPHY, para. 3" } as any),
    "[Patanjali, Yoga Sutras, CHAPTER XIX, THAT TO STUDY PHILOSOPHY, para. 3]",
  );
  assert.equal(
    cite({ ...top, paginated: 0, page_start: "BOOK II—OF THE SOUL, para. 7" } as any),
    "[Patanjali, Yoga Sutras, BOOK II, OF THE SOUL, para. 7]",
  );
  // A single hyphen is part of a word, not a separator, so it survives. Two would not.
  assert.equal(
    cite({ ...top, paginated: 0, page_start: "well-being, para. 1" } as any),
    "[Patanjali, Yoga Sutras, well-being, para. 1]",
  );
  // Page ranges are built with a hyphen after this runs, so they are untouched by it.
  assert.equal(cite({ ...top, page_start: "12", page_end: "13" } as any), "[Patanjali, Yoga Sutras, p. 12-13]");

  // Gutenberg footnote markers put brackets inside chapter titles. Nested inside the
  // citation's own brackets they defeated the verifier's citation stripping, so every
  // correct quote from such a chapter was dropped as fabricated. Both ends are covered:
  // the locator carries no brackets, and the stripper survives them if one ever does.
  const bracketed = cite({ ...top, paginated: 0, page_start: "HEROISM[309], para. 7" } as any);
  assert.equal(bracketed, "[Patanjali, Yoga Sutras, HEROISM309, para. 7]");
  const emerson = "To this military attitude of the soul we give the name of Heroism.";
  assert.deepEqual(
    unverifiedQuotes(`> ${emerson} [Essays, Emerson, HEROISM[309], para. 7]`, [
      { ...top, text: emerson },
    ] as any),
    [],
    "a quote whose citation contains brackets must still verify",
  );

  // The inline scanner exists to catch quotations the model writes in its own prose. Run
  // over the spliced blockquotes too it paired a quotation mark inside one passage with one
  // inside another and reported the whole answer, blockquote markers and all, as a single
  // fabricated quote. Sources are full of such marks.
  const marked = 'He called it a "sovereign" faculty of the mind, and said so plainly.';
  const alsoMarked = 'The other passage speaks of "common people" and their stumbling.';
  assert.deepEqual(
    unverifiedQuotes(`> ${marked}\n\nSome linking prose.\n\n> ${alsoMarked}`, [
      { ...top, text: marked },
      { ...top, text: alsoMarked },
    ] as any),
    [],
    "quotation marks inside verbatim passages must not be scanned as inline quotes",
  );

  // ...but a quotation the model types in its own prose is still caught.
  assert.deepEqual(
    unverifiedQuotes('He wrote that "this sentence appears in no book in the library at all".', [
      { ...top, text: marked },
    ] as any),
    ["this sentence appears in no book in the library at all"],
    "an invented inline quotation must still be reported",
  );

  // A stray mark in one paragraph must not pair with one in another. An inline quotation sits
  // inside a sentence, so pairing across paragraphs can only capture the prose between them.
  assert.deepEqual(
    unverifiedQuotes(
      'He called the faculty "sovereign" here.\n\nA later paragraph mentions "vision" again.',
      [{ ...top, text: marked }] as any,
    ),
    [],
    "quote marks in separate paragraphs must not pair across them",
  );

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

  // A user id reaches the filesystem. These are the shapes that would read or clobber
  // another reader's library, and they must throw rather than be sanitised into something.
  for (const bad of ["../demo", "a/b", "", ".", "x".repeat(65), "user\0"]) {
    assert.throws(() => userLibrary(bad, dir), /invalid user id/, `accepted ${JSON.stringify(bad)}`);
  }

  // First sight of a user clones the starter; the clone is a working library, not an
  // empty file, and the two readers get separate files.
  process.env.GURU_STARTER = join(dir, "library.db");
  const users = join(dir, "users");
  assert(userLibrary("user_2abc", users).prepare("select count(*) n from chunks").get());
  assert(existsSync(join(users, "user_2abc.db")), "starter was not cloned");
  const second = userLibrary("user_2def", users);
  assert.equal((second.prepare("select count(*) n from chunks").get() as any).n, 6);

  // Re-adding the same source replaces the book rather than shelving it twice, and takes its
  // old chunks out of both indexes. A duplicate here is not cosmetic: the second copy
  // competes with the first in the fused ranking for every query.
  const before = conn.prepare("select count(*) n from chunks_fts").get() as { n: number };
  await addBook(conn, extract(pdf));
  assert.equal((conn.prepare("select count(*) n from books").get() as any).n, 1, "book duplicated");
  assert.deepEqual(conn.prepare("select count(*) n from chunks_fts").get(), before, "stale index rows");
  assert.equal((conn.prepare("select count(*) n from chunks_vec").get() as any).n, before.n);

  // The daily allowance. Counted per reader in their own file, so it survives a restart and
  // travels with an export, and so an uncapped reader cannot outspend their subscription.
  assert.equal(askedToday(conn), 0);
  recordAsk(conn);
  recordAsk(conn);
  assert.equal(askedToday(conn), 2);
  // Yesterday's questions must not be charged against today's allowance.
  conn.prepare("update asks set at = datetime('now','-1 day') where id = 1").run();
  assert.equal(askedToday(conn), 1);

  // The ingest queue. Claiming is the part that matters: two workers racing on the same row
  // would ingest one book twice into one library.
  const queue = openJobs(join(dir, "jobs.db"));
  const id = enqueueJob(queue, "user_2abc", "/tmp/a.pdf", "a.pdf");
  assert.equal(countActive(queue, "user_2abc"), 1);
  assert.equal(claim(queue)?.id, id);
  assert.equal(claim(queue), undefined, "a claimed job was handed out twice");

  // A worker killed mid-book must not strand the row in `running` forever.
  assert.equal(requeueStale(queue), 1);
  assert.equal(claim(queue)?.id, id);

  finish(queue, id, "not a pdf");
  assert.equal(countActive(queue, "user_2abc"), 0);
  assert.equal(listJobs(queue, "user_2abc")[0].state, "failed");
  assert.equal(countActive(queue, "user_2xyz"), 0, "job counted against the wrong reader");

  console.error(`selfcheck ok: ${hits.length} hits, top ${cite(top)}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const withContext = rest.includes("--context");
const offsetAt = rest.indexOf("--page-offset");
const pageOffset = offsetAt === -1 ? 0 : Number(rest[offsetAt + 1]);
const limitAt = rest.indexOf("--limit");
const bookLimit = limitAt === -1 ? Infinity : Number(rest[limitAt + 1]);
const bookAt = rest.indexOf("--book");
const selection = bookAt === -1 ? undefined : rest[bookAt + 1] ?? "invalid";
// A flag and its value must both drop out, or `ask --limit 5 what is the self?` searches for
// the flag along with the question.
const flagged = new Set(
  [offsetAt, limitAt, bookAt].flatMap((i) => (i === -1 ? [] : [i, i + 1])),
);
const arg = rest.filter((a, i) => a !== "--context" && !flagged.has(i)).join(" ");

if (cmd === "add") await add(arg, pageOffset, withContext);
else if (cmd === "starter") await starter(withContext, bookLimit);
else if (cmd === "find") await find(arg, selection);
else if (cmd === "ask") await ask(arg, selection);
else if (cmd === "books") {
  const conn = db();
  try { for (const book of listBooks(conn)) console.log(`${book.id}\t${book.title}\t${book.author}`); }
  finally { conn.close(); }
}
else if (cmd === "worker") await worker();
else if (cmd === "selfcheck") await selfcheck();
else
  console.log(
    `usage: ${profile.id} add BOOK.pdf [--page-offset N] [--context] | starter [--limit N] [--context] | books | find QUERY [--book ID] | ask QUESTION [--book ID] | worker | selfcheck`,
  );
