#!/usr/bin/env node
// ESM hoists imports, so this runs AFTER ./llm.ts is evaluated. That is fine
// because llm.ts resolves its provider on first use rather than at module scope.
// Optional by design: the pipeline runs against a local router with no .env.
try {
  process.loadEnvFile();
} catch {
  // no .env, or a runtime without loadEnvFile — env vars may still be set externally
}

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { addBook, askedToday, cite, open, recordAsk, search, userLibrary, type Book } from "./store.ts";
import {
  claim,
  countActive,
  enqueue as enqueueJob,
  finish,
  listJobs,
  openJobs,
  requeueStale,
} from "./jobs.ts";
import { ask as askClaude, contextualize, expandQuery, rerank, unverifiedQuotes } from "./llm.ts";

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

/** The public-domain corpus every user gets on day one, and the eval corpus. */
export const STARTER_DIR = "data/starter";

export async function fetchStarter() {
  const books = JSON.parse(readFileSync("starter/library.json", "utf8")) as {
    gutenberg: number;
    author: string;
    title: string;
  }[];
  mkdirSync(STARTER_DIR, { recursive: true });
  const paths: string[] = [];
  for (const b of books) {
    const path = join(STARTER_DIR, `${b.author} - ${b.title}.epub`);
    if (!existsSync(path)) {
      const res = await fetch(`https://www.gutenberg.org/ebooks/${b.gutenberg}.epub3.images`);
      if (!res.ok) throw new Error(`gutenberg ${b.gutenberg}: ${res.status}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      console.error(`fetched ${b.title}`);
    }
    paths.push(path);
  }
  return paths;
}

async function starter(withContext: boolean) {
  for (const path of await fetchStarter()) await add(path, 0, withContext);
}

/**
 * The retrieval stack, measured on 90 eval cases (recall@5):
 *   search alone 20% · +rerank 37% · +HyDE 59%
 * HyDE is what raises the recall ceiling; rerank then promotes almost everything
 * search found. Both are needed — neither alone gets close.
 */
async function retrieve(query: string) {
  return rerank(query, await search(db(), await expandQuery(query)));
}

async function find(query: string) {
  for (const hit of await retrieve(query)) {
    console.log(`\n${cite(hit)}  score ${hit.score.toFixed(4)}`);
    console.log(hit.text.slice(0, 300).replace(/\n/g, " "));
  }
}

async function ask(query: string) {
  const hits = await retrieve(query);
  if (!hits.length) return console.log("your library doesn't cover this.");
  const { answer, regenerated, dropped } = await askClaude(query, hits);
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
 * is also the security boundary — see the sidecar note in `extract`.
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
      // upload path that is unique every time — so re-uploading a book would add a second
      // copy instead of replacing the first. Key on what the reader actually sent.
      await addBook(userLibrary(job.user_id), { ...book, source: job.filename });
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
  await addBook(conn, extract(pdf));

  // The whole promise: ask for a known quote, get the page it is actually on.
  const hits = await search(conn, "Yoga is the stilling of the fluctuations of the mind");
  assert(hits.length, "no hits");
  const top = hits[0];
  assert(top.text.includes("stilling of the fluctuations"), `wrong top hit: ${top.text.slice(0, 80)}`);
  assert.equal(cite(top), "[Yoga Sutras, Patanjali, p. 3-4]");

  // Unpaginated sources cite chapter and paragraph, and EPUB chapter titles arrive wrapped.
  // A locator must stay on one line or it renders half inside the blockquote.
  assert.equal(
    cite({ ...top, paginated: 0, page_start: 'Lectures VI And VII. The "Sick\n Soul.",' } as any),
    "[Yoga Sutras, Patanjali, Lectures VI And VII. The Sick Soul.,]",
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
  // travels with an export — and so an uncapped reader cannot outspend their subscription.
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
const arg = rest
  .filter((a, i) => a !== "--context" && (offsetAt === -1 || (i !== offsetAt && i !== offsetAt + 1)))
  .join(" ");

if (cmd === "add") await add(arg, pageOffset, withContext);
else if (cmd === "starter") await starter(withContext);
else if (cmd === "find") await find(arg);
else if (cmd === "ask") await ask(arg);
else if (cmd === "worker") await worker();
else if (cmd === "selfcheck") await selfcheck();
else
  console.log(
    "usage: guru add BOOK.pdf [--page-offset N] [--context] | starter [--context] | find QUERY | ask QUESTION | worker | selfcheck",
  );
