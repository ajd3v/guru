#!/usr/bin/env node
// Milestone 3, slice 1: the retrieval + answer path over HTTP.
//
//   node src/server.ts            # http://localhost:8080
//
// Libraries are per-user files, resolved per request. The only thing still missing is a real
// identity provider. See `currentUser` below.
try {
  process.loadEnvFile();
} catch {
  // no .env; env vars may still be set externally
}

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { authenticate, basicAuthOk, toWebRequest } from "./auth.ts";
import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askedToday, cite, libraryPath, recordAsk, search, userLibrary } from "./store.ts";
import { ask, expandQuery, rerank } from "./llm.ts";
import { countActive, enqueue, listJobs, openJobs } from "./jobs.ts";

const PORT = Number(process.env.PORT ?? 8080);

const UPLOADS = process.env.GURU_UPLOADS ?? "data/uploads";
const MAX_UPLOAD = Number(process.env.GURU_MAX_UPLOAD ?? 100 * 1024 * 1024);
/** Fair-use cap from SPEC.md, counted against books already held plus books in flight. */
const MAX_BOOKS = Number(process.env.GURU_MAX_BOOKS ?? 50);
const ACCEPTED = [".pdf", ".epub"];

/**
 * Questions per reader per UTC day.
 *
 * Not a nicety: an answer costs roughly $0.04 in model calls (four rerank batches plus the
 * answer), so an uncapped reader on a ~$12/month plan turns a profit into a loss somewhere
 * around ten questions a day. This has to exist before there is anything to bill.
 */
const MAX_ASKS = Number(process.env.GURU_MAX_ASKS ?? 40);

/**
 * Stream the body to disk, refusing to buffer it.
 *
 * The cap is checked per chunk rather than against content-length: the header is a claim by
 * the client, and a body that keeps going after it is how a "10MB" upload fills the volume.
 */
/** Form bodies, which are small. Files go through `receive` and never through memory. */
async function body(req: IncomingMessage, limit = 64 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

async function receive(req: IncomingMessage, dest: string, limit: number) {
  const out = createWriteStream(dest);
  let size = 0;
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new Error("too large");
      if (!out.write(chunk)) await once(out, "drain");
    }
    await new Promise<void>((resolve, reject) => out.end(() => resolve()).on("error", reject));
    return size;
  } catch (err) {
    out.destroy();
    await rm(dest, { force: true });
    throw err;
  }
}

// A question is user input crossing a trust boundary into an LLM prompt and an FTS5 query.
// Length is the only limit worth enforcing here: store.ts already quotes every FTS token,
// and the answer model is instructed to cite ids from the catalogue rather than free text.
const MAX_QUERY = 500;

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * The answer is blockquotes and citations. That is the whole product, so it gets markup.
 *
 * Grouping is per line, not per blank-line paragraph: the model routinely puts a quote and
 * the sentence that follows it in one block, and a paragraph-level test then classifies the
 * whole thing as prose and renders a verbatim quotation as the model's own words.
 */
function render(answer: string) {
  const out: string[] = [];
  let buf: string[] = [];
  let quoting = false;
  const flush = () => {
    if (buf.length) {
      const text = buf.join(" ");
      if (!quoting) out.push(`<p>${text}</p>`);
      else {
        // Split the locator off the passage. It trails the quote as `[Title, Author, p. N]`
        // and reads as part of the author's sentence unless it is given its own element.
        const m = text.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
        out.push(
          m
            ? `<blockquote><p>${m[1]}</p><cite>${m[2]}</cite></blockquote>`
            : `<blockquote><p>${text}</p></blockquote>`,
        );
      }
    }
    buf = [];
  };

  for (const raw of escape(answer).split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const quoted = line.startsWith("&gt;");
    if (quoted !== quoting) flush();
    quoting = quoted;
    // A prose line trailing a quote starts with the punctuation that closed the sentence the
    // quote was spliced into ("… as follows [quote]. This is why …"). Drop the orphan.
    buf.push(quoted ? line.replace(/^&gt; ?/, "") : line.replace(/^[.,;:]\s*/, ""));
  }
  flush();
  return out.join("\n");
}

// Same convention as `cli.ts selfcheck` and `ingest.py --selfcheck`: assert, then exit before
// opening a database or binding a port, so `npm test` can run it with no side effects.
if (process.argv.includes("--selfcheck")) {
  assert.equal(render("Plain claim [Tao, Laozi, p. 1]"), "<p>Plain claim [Tao, Laozi, p. 1]</p>");
  assert.equal(render("> a quote\n> wrapped"), "<blockquote><p>a quote wrapped</p></blockquote>");
  // The locator becomes its own element. Left inside the quote it reads as part of the
  // author's sentence, which is the one thing a citation must never look like.
  assert.equal(
    render("> quote [Tao, Laozi, p. 1]\nand the claim it supports"),
    "<blockquote><p>quote</p><cite>Tao, Laozi, p. 1</cite></blockquote>\n<p>and the claim it supports</p>",
  );
  assert.equal(render("claim\n> quote"), "<p>claim</p>\n<blockquote><p>quote</p></blockquote>");
  assert.equal(render("> quote\n. and the rest of the sentence"),
    "<blockquote><p>quote</p></blockquote>\n<p>and the rest of the sentence</p>");
  assert.match(render('<script>alert("x")</script>'), /&lt;script&gt;/);

  // Clerk reads the session cookie off a fetch Request, which Node does not hand us.
  const fake = (headers: Record<string, unknown>, url = "/ask") =>
    ({ url, method: "POST", headers }) as any;
  const plain = toWebRequest(fake({ host: "guru.app", cookie: "__session=abc" }));
  assert.equal(plain.url, "http://guru.app/ask");
  assert.equal(plain.headers.get("cookie"), "__session=abc");
  // Behind a TLS-terminating proxy the scheme only survives in this header, and getting it
  // wrong makes every session cookie look like it came from the wrong origin.
  assert.match(toWebRequest(fake({ host: "guru.app", "x-forwarded-proto": "https" })).url, /^https:/);
  assert.equal(toWebRequest(fake({ host: "guru.app", "set-cookie": ["a=1", "b=2"] })).headers.get("set-cookie"), "a=1, b=2");

  // With no keys configured, every request is the local dev user. That is the state this repo is
  // in right now, and the one that must be impossible in production.
  assert.deepEqual(await authenticate(fake({ host: "localhost" })), { kind: "user", userId: "demo" });

  // The guard that keeps that fallback off a public box. Loaded in a child process because
  // it fires at module scope, which is the only place it can run before serving a request.
  const boot = (env: Record<string, string>) =>
    execFileSync(process.execPath, ["-e", "import('./src/auth.ts')"], {
      env: { ...process.env, NODE_ENV: "production", CLERK_SECRET_KEY: "", GURU_ORIGINS: "", GURU_SINGLE_USER: "", ...env },
      stdio: "pipe",
    });
  assert.throws(() => boot({}), /CLERK_SECRET_KEY is required/, "production with no auth must refuse to boot");
  // Single-user serves one whole library to whoever asks, so in production it must carry a
  // password. This pairing is the actual danger, and it is refused rather than documented.
  assert.throws(
    () => boot({ GURU_SINGLE_USER: "reader" }),
    /GURU_BASIC_AUTH .* is required/,
    "single-user without a password must refuse to boot in production",
  );
  assert.doesNotThrow(
    () => boot({ GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:hunter2" }),
    "single-user with a password must boot",
  );

  // The credential check itself. Wrong password, wrong scheme, and absent header must all
  // fail; only the exact pair passes.
  const ok = (h: string | undefined) => basicAuthOk(h, "ajd3v:s3cret");
  const header = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;
  assert.equal(ok(header("ajd3v:s3cret")), true);
  assert.equal(ok(header("ajd3v:wrong")), false);
  assert.equal(ok(header("ajd3v:s3cret ")), false, "trailing whitespace must not pass");
  assert.equal(ok(header("other:s3cret")), false);
  assert.equal(ok(undefined), false);
  assert.equal(ok("Bearer abc"), false);
  assert.equal(basicAuthOk(undefined, undefined), true, "no credential configured means no check");

  // Uploads are capped while streaming, not from content-length, because the header is the
  // client's word. A body that keeps going must be cut off and its partial file removed.
  const tmp = mkdtempSync(join(tmpdir(), "guru-up-"));
  const body = async function* (n: number) {
    for (let i = 0; i < n; i++) yield Buffer.alloc(1024);
  };
  const small = join(tmp, "ok.bin");
  assert.equal(await receive(body(4) as any, small, 8 * 1024), 4096);
  assert.equal(statSync(small).size, 4096);

  const over = join(tmp, "over.bin");
  await assert.rejects(receive(body(64) as any, over, 8 * 1024), /too large/);
  assert.equal(existsSync(over), false, "an over-cap upload left its partial file behind");
  rmSync(tmp, { recursive: true, force: true });

  console.error("server selfcheck ok");
  process.exit(0);
}

const jobs = openJobs();

/**
 * One page, set like a book rather than a chat window.
 *
 * The typographic decision that drives the rest: quotations are the product and the model's
 * prose is connective tissue, so the usual hierarchy is inverted. Passages are set larger and
 * in full ink; the sentences linking them are smaller and quieter.
 *
 * The mark is concentric rings, one centre, many circles around it, which is the thing this
 * does, and deliberately belongs to no tradition. Nothing is fetched: no webfont, no script
 * from anywhere, so the page renders whole on the first byte.
 */
const PAGE = (body = "") => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>guru</title>
<style>
  :root {
    --paper: #f6f3ec; --ink: #23211c; --quiet: #7d776b; --rule: #ddd7c9; --field: #eae5d9;
    /* Old-style serifs, in order of how good they look. No webfont: a page about patient
       reading should not wait on a network round trip to show its first line. */
    --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "URW Palladio L", "Book Antiqua", Georgia, serif;
    --small: ui-monospace, "SF Mono", "IBM Plex Mono", "DejaVu Sans Mono", monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #14130f; --ink: #e6e1d5; --quiet: #8b8578; --rule: #2e2b24; --field: #1d1b16; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: clamp(3rem, 10vh, 7rem) 1.5rem 6rem;
    background: var(--paper); color: var(--ink);
    font: 1.0625rem/1.75 var(--serif);
    font-feature-settings: "kern", "liga", "onum";
    -webkit-font-smoothing: antialiased;
  }
  .sheet { max-width: 36rem; margin: 0 auto; }

  header { text-align: center; margin-bottom: clamp(2.5rem, 7vh, 4.5rem); }
  .mark { width: 46px; height: 46px; fill: none; stroke: currentColor; stroke-width: 1; color: var(--quiet); }
  .mark circle { opacity: .55; transform-origin: 32px 32px; animation: breathe 11s ease-in-out infinite; }
  .mark circle:nth-child(2) { animation-delay: -2.6s; }
  .mark circle:nth-child(3) { animation-delay: -5.2s; }
  .mark circle:nth-child(4) { animation-delay: -7.8s; fill: currentColor; stroke: none; }
  @keyframes breathe { 0%, 100% { opacity: .25; } 50% { opacity: .7; } }
  @media (prefers-reduced-motion: reduce) { .mark circle { animation: none; opacity: .5; } }

  h1 { margin: .9rem 0 .3rem; font-size: 1.5rem; font-weight: 400; letter-spacing: .34em;
       text-indent: .34em; text-transform: lowercase; }
  .tagline { margin: 0; color: var(--quiet); font-size: .9375rem; font-style: italic; }

  /* The question sits on a ruled line, like writing on a page, not inside a widget. */
  .ask { display: flex; gap: .75rem; align-items: baseline;
         border-bottom: 1px solid var(--rule); padding-bottom: .5rem; margin-bottom: 3.5rem; }
  .ask input { flex: 1; min-width: 0; border: 0; background: transparent; color: inherit;
               font: italic 1.125rem/1.6 var(--serif); padding: .3rem 0; }
  .ask input::placeholder { color: var(--quiet); opacity: .8; }
  .ask input:focus { outline: none; }
  .ask:focus-within { border-bottom-color: var(--ink); }
  .ask button { border: 0; background: none; color: var(--quiet); cursor: pointer;
                font: .75rem/1 var(--small); letter-spacing: .18em; text-transform: uppercase; }
  .ask button:hover { color: var(--ink); }

  h2 { font-size: 1.25rem; font-weight: 400; font-style: italic; color: var(--quiet);
       margin: 0 0 2rem; text-wrap: balance; }

  /* Inverted hierarchy: the passage is the payload, the prose around it is scaffolding. */
  blockquote { margin: 2.25rem 0; }
  blockquote p { margin: 0; font-size: 1.1875rem; line-height: 1.62; text-wrap: pretty; }
  blockquote p::before { content: "\\201C"; margin-left: -.42em; }
  blockquote p::after { content: "\\201D"; }
  cite { display: block; margin-top: .7rem; color: var(--quiet); font: normal .6875rem/1.5 var(--small);
         letter-spacing: .1em; font-style: normal; }
  .answer > p { color: var(--quiet); font-size: .9375rem; text-wrap: pretty; }

  .note { color: var(--quiet); font-size: .8125rem; }
  .note a { color: inherit; text-underline-offset: .2em; }
  details { margin-top: 2.5rem; }
  summary { cursor: pointer; font: .6875rem/1.6 var(--small); letter-spacing: .12em;
            text-transform: uppercase; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: "+ "; }
  details[open] summary::before { content: "\\2212 "; }
  summary:hover { color: var(--ink); }
  ul.shelf { list-style: none; padding: 0; margin: 3rem 0 0; }
  ul.shelf li { padding: .35rem 0; border-bottom: 1px solid var(--rule); font-size: .875rem;
                color: var(--quiet); text-wrap: pretty; }
  ul.shelf li:last-child { border-bottom: 0; }

  footer { margin-top: 4rem; padding-top: 1.5rem; border-top: 1px solid var(--rule);
           display: flex; flex-wrap: wrap; gap: 1rem 1.5rem; align-items: center; }
  footer form { display: flex; gap: .5rem; margin: 0 0 0 auto; }
  footer input { border: 0; border-bottom: 1px solid var(--rule); background: transparent;
                 color: inherit; font: .75rem/1.6 var(--small); width: 7rem; padding: .2rem 0; }
  footer input:focus { outline: none; border-bottom-color: var(--ink); }
  footer button, .file { border: 0; background: none; padding: 0; color: var(--quiet); cursor: pointer;
                         font: .6875rem/1.6 var(--small); letter-spacing: .12em; text-transform: uppercase; }
  footer button:hover, .file:hover { color: var(--ink); }
  .file input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  /* The waiting line breathes at the same slow rate as the mark, so the page has one pulse
     rather than two competing ones. */
  .waiting { animation: breathe 3.2s ease-in-out infinite; }
  .waiting::after { content: "\\2026"; }
  .answer, h2 { animation: rise .5s ease-out both; }
  @media (prefers-reduced-motion: reduce) { .answer, h2 { animation: none; } }
  @keyframes rise { from { opacity: 0; transform: translateY(.4rem); } to { opacity: 1; transform: none; } }
</style>
<div class="sheet">
<header>
  <svg class="mark" viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="32" r="30"/><circle cx="32" cy="32" r="21.5"/>
    <circle cx="32" cy="32" r="13"/><circle cx="32" cy="32" r="3.4"/>
  </svg>
  <h1>guru</h1>
  <p class="tagline">Your own library, answering in its own words.</p>
</header>
<form class="ask" method="post" action="/ask">
  <input name="q" maxlength="${MAX_QUERY}" placeholder="Ask your library&hellip;" autofocus>
  <button>Ask</button>
</form>
<div id="out">${body}</div>
<footer>
  <label class="file">Add a book
    <input type="file" accept=".pdf,.epub" id="f"></label>
  <span class="note" id="s"></span>
  <a class="note" href="/export">Export</a>
  <form method="post" action="/delete">
    <input name="confirm" placeholder="type DELETE">
    <button>Delete all</button>
  </form>
</footer>
</div>
<script>
  // Progressive enhancement: without this the form posts normally and the page renders the
  // whole answer at once. With it, the passages appear as soon as they are found and the
  // answer replaces the waiting line when it is written.
  const form = document.querySelector("form.ask"), out = document.getElementById("out");
  form.addEventListener("submit", async (e) => {
    const q = form.q.value.trim();
    if (!q) return;
    e.preventDefault();

    out.innerHTML = '<h2></h2><p class="note waiting">searching your library</p>';
    out.querySelector("h2").textContent = q;
    const waiting = () => out.querySelector(".waiting");

    let res;
    try {
      res = await fetch("/ask", {
        method: "POST",
        headers: { accept: "text/event-stream", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ q }),
      });
    } catch { waiting().textContent = "could not reach the server"; return; }

    // The daily cap and an over-long question come back as ordinary status codes with a
    // whole page, so fall back to letting the browser render it.
    if (!res.ok || !(res.headers.get("content-type") || "").includes("event-stream")) {
      document.open(); document.write(await res.text()); document.close(); return;
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "", passages = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      // SSE frames are separated by a blank line; anything after the last one is a partial
      // frame and has to stay in the buffer until the rest of it arrives.
      const frames = buf.split("\\n\\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const name = (frame.match(/^event: (.*)$/m) || [])[1];
        const data = JSON.parse((frame.match(/^data: (.*)$/m) || [])[1] || "{}");
        if (name === "stage" && waiting()) waiting().textContent = data.text;
        if (name === "passages") {
          passages = data.html;
          if (waiting()) waiting().textContent = data.text + ", composing an answer";
        }
        if (name === "answer") {
          out.innerHTML = '<h2></h2>' + data.html + passages;
          out.querySelector("h2").textContent = q;
        }
      }
    }
    if (waiting()) waiting().textContent = "the answer did not arrive";
  });

  // The file is the whole request body, no multipart, so the server needs no parser for it.
  document.getElementById("f").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const s = document.getElementById("s");
    s.textContent = "reading\\u2026";
    const r = await fetch("/upload?name=" + encodeURIComponent(file.name), {
      method: "PUT", body: file,
    });
    s.textContent = await r.text();
    if (r.ok) setTimeout(() => location.reload(), 1500);
  };
</script>`;

/** What the reader has, and what is still being read in. */
function shelf(user: string) {
  const db = userLibrary(user);
  const books = db.prepare("select title, author from books order by title").all() as {
    title: string;
    author: string;
  }[];
  db.close();

  const pending = listJobs(jobs, user)
    .filter((j) => j.state !== "done")
    .map((j) =>
      j.state === "failed"
        ? `<li>${escape(j.filename)}, <span class="note">could not be read: ${escape(j.error ?? "")}</span></li>`
        : `<li>${escape(j.filename)}, <span class="note">${j.state}&hellip;</span></li>`,
    );

  const shelved = books.map((b) => `<li>${escape(b.title)}, ${escape(b.author)}</li>`);

  // Anything in flight stays visible; the shelf itself folds away. Landing on fourteen book
  // titles makes the first screen a stock list, when the only thing to do here is ask.
  return (
    (pending.length ? `<ul class="shelf">${pending.join("")}</ul>` : "") +
    (shelved.length
      ? `<details class="note"><summary>${shelved.length} books on your shelf</summary>` +
        `<ul class="shelf">${shelved.join("")}</ul></details>`
      : "")
  );
}

createServer(async (req, res) => {
  const send = (code: number, html: string) =>
    res.writeHead(code, { "content-type": "text/html; charset=utf-8" }).end(html);

  const auth = await authenticate(req);
  if (auth.kind === "respond") {
    // Clerk's headers carry the session cookie and redirect target; forward them as given.
    return res.writeHead(auth.status, Object.fromEntries(auth.headers)).end();
  }
  const user = auth.userId;

  if (req.method === "GET" && req.url === "/") return send(200, PAGE(shelf(user)));

  if (req.method === "PUT" && req.url?.startsWith("/upload")) {
    const text = (code: number, msg: string) =>
      res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }).end(msg);

    const name = new URL(req.url, "http://x").searchParams.get("name") ?? "";
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    // The extension decides which parser runs, so it is checked against a list rather than
    // sniffed. The name itself never becomes a path. See the generated destination below.
    if (!ACCEPTED.includes(ext)) return text(415, `Only ${ACCEPTED.join(" and ")} files.`);

    const db = userLibrary(user);
    const held = (db.prepare("select count(*) n from books").get() as { n: number }).n;
    db.close();
    if (held + countActive(jobs, user) >= MAX_BOOKS) {
      return text(409, `Library is full (${MAX_BOOKS} books).`);
    }

    await mkdir(UPLOADS, { recursive: true });
    // Destination is generated, never derived from the upload's name: a filename is attacker
    // input, and `../../data/users/someone.db` would otherwise be a valid place to write.
    const dest = join(UPLOADS, `${user}-${Date.now()}${ext}`);
    try {
      await receive(req, dest, MAX_UPLOAD);
    } catch {
      return text(413, "That file is too large.");
    }
    enqueue(jobs, user, dest, name);
    return text(202, "Queued. It will appear in your library shortly.");
  }

  // GDPR, and cheap because a reader is one file: their books, chunks, and usage all travel
  // together. WAL is checkpointed first or the copy arrives missing its most recent writes.
  if (req.method === "GET" && req.url === "/export") {
    const db = userLibrary(user);
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    res.writeHead(200, {
      "content-type": "application/vnd.sqlite3",
      "content-disposition": `attachment; filename="guru-${user}.db"`,
    });
    return void createReadStream(libraryPath(user)).pipe(res);
  }

  if (req.method === "POST" && req.url === "/delete") {
    const form = new URLSearchParams(await body(req));
    // Irreversible and one request away from the ask form, so it takes a deliberate word
    // rather than a bare POST.
    if (form.get("confirm") !== "DELETE") return send(400, PAGE("<p>Type DELETE to confirm.</p>"));

    for (const j of listJobs(jobs, user, 1000)) await rm(j.path, { force: true });
    jobs.prepare("delete from jobs where user_id = ?").run(user);
    // -wal and -shm hold data too; leaving them behind would seed the next database of the
    // same name with the deleted reader's writes.
    for (const suffix of ["", "-wal", "-shm"]) await rm(libraryPath(user) + suffix, { force: true });
    return send(200, PAGE("<p>Your library and its history are gone.</p>"));
  }

  if (req.method !== "POST" || req.url !== "/ask") return send(404, PAGE("<p>Not found.</p>"));

  const query = new URLSearchParams(await body(req)).get("q")?.trim() ?? "";
  if (!query) return send(400, PAGE("<p>Ask something.</p>"));
  if (query.length > MAX_QUERY) return send(413, PAGE("<p>That question is too long.</p>"));

  try {
    const db = userLibrary(user);
    // Counted before the work, not after: the cost is incurred whether or not the pipeline
    // finds an answer, and a failed question that refunds its slot is a free retry loop.
    if (askedToday(db) >= MAX_ASKS) {
      db.close();
      return send(429, PAGE(`<p>That's ${MAX_ASKS} questions today. Back tomorrow.</p>`));
    }
    recordAsk(db);

    /**
     * Answering takes about eighteen seconds, most of it composing. The passages are known
     * after roughly seven, and they are the thing the reader came for, so a client that can
     * stream is given them to read while the rest is written. No invented progress bar: every
     * event carries something true that has actually happened.
     */
    const streaming = (req.headers.accept ?? "").includes("text/event-stream");
    let emit = (_event: string, _data: unknown) => {};
    if (streaming) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        // Traefik and friends will otherwise hold the whole response to compress it, which
        // buffers away the only thing streaming is for.
        "x-accel-buffering": "no",
      });
      emit = (event, data) => void res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    emit("stage", { text: "searching your library" });
    const hits = await rerank(query, await search(db, await expandQuery(query)));
    if (!hits.length) {
      const none = "<p>Your library doesn't cover this.</p>";
      if (!streaming) return send(200, PAGE(none));
      emit("answer", { html: none });
      return void res.end();
    }

    const sources = [...new Set(hits.map(cite))].map((c) => `<li>${escape(c)}</li>`).join("");
    // What was read but not quoted: available to anyone who wants to check the work, folded
    // away from anyone who does not.
    const consulted =
      `<details class="note"><summary>Passages consulted</summary>` +
      `<ul class="shelf">${sources}</ul></details>`;
    emit("passages", {
      html: consulted,
      text: `reading ${hits.length} passage${hits.length > 1 ? "s" : ""}`,
    });

    const { answer, dropped } = await ask(query, hits);
    const note = dropped
      ? `<p class="note">${dropped} claim${dropped > 1 ? "s" : ""} dropped: the quotation could not be verified.</p>`
      : "";
    const composed = `<div class="answer">${render(answer)}</div>`;

    if (!streaming) {
      return send(200, PAGE(`<h2>${escape(query)}</h2>${composed}${consulted}${note}`));
    }
    emit("answer", { html: composed + note });
    res.end();
  } catch (err) {
    // The pipeline calls an upstream model. A failure there is not the reader's fault and
    // must not render as an unsourced answer, so it is reported as a failure.
    console.error(err);
    const failed = "<p>Something failed upstream. Try again.</p>";
    // A stream that has already sent its headers cannot be given a status; it has to say so
    // in an event and close, or the reader watches a spinner that never resolves.
    if (res.headersSent) {
      res.write(`event: answer\ndata: ${JSON.stringify({ html: failed })}\n\n`);
      res.end();
    } else {
      send(502, PAGE(failed));
    }
  }
}).listen(PORT, () => console.error(`guru on http://localhost:${PORT}`));
