#!/usr/bin/env node
// Milestone 3, slice 1: the retrieval + answer path over HTTP.
//
//   node src/server.ts            # http://localhost:8080
//
// Libraries are per-user files, resolved per request. The only thing still missing is a real
// identity provider — see `currentUser` below.
try {
  process.loadEnvFile();
} catch {
  // no .env; env vars may still be set externally
}

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { authenticate, toWebRequest } from "./auth.ts";
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
    if (buf.length) out.push(quoting ? `<blockquote>${buf.join(" ")}</blockquote>` : `<p>${buf.join(" ")}</p>`);
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
  assert.equal(render("> a quote\n> wrapped"), "<blockquote>a quote wrapped</blockquote>");
  // The common shape in real answers: a quote and its trailing prose with no blank line
  // between them. The quote must still render as a quote.
  assert.equal(render("> quote [Tao, Laozi, p. 1]\nand the claim it supports"),
    "<blockquote>quote [Tao, Laozi, p. 1]</blockquote>\n<p>and the claim it supports</p>");
  assert.equal(render("claim\n> quote"), "<p>claim</p>\n<blockquote>quote</blockquote>");
  assert.equal(render("> quote\n. and the rest of the sentence"),
    "<blockquote>quote</blockquote>\n<p>and the rest of the sentence</p>");
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

  // With no keys configured, every request is the local dev user — the state this repo is
  // in right now, and the one that must be impossible in production.
  assert.deepEqual(await authenticate(fake({ host: "localhost" })), { kind: "user", userId: "demo" });

  // The guard that keeps that fallback off a public box. Loaded in a child process because
  // it fires at module scope, which is the only place it can run before serving a request.
  assert.throws(
    () => execFileSync(process.execPath, ["-e", "import('./src/auth.ts')"], {
      env: { ...process.env, NODE_ENV: "production", CLERK_SECRET_KEY: "", GURU_ORIGINS: "" },
      stdio: "pipe",
    }),
    /CLERK_SECRET_KEY is required/,
    "production without Clerk keys must refuse to boot",
  );

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

const PAGE = (body = "") => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>guru</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.6;
         font: 1rem/1.6 Georgia, serif; }
  form { display: flex; gap: .5rem; margin-bottom: 2rem; }
  input { flex: 1; padding: .6rem .8rem; font: inherit; border: 1px solid #8888; border-radius: 4px; }
  button { padding: .6rem 1.2rem; font: inherit; cursor: pointer; }
  blockquote { margin: 1.2rem 0; padding-left: 1rem; border-left: 3px solid #8888; font-style: italic; }
  .note { opacity: .6; font-size: .85rem; }
  .shelf { list-style: none; padding: 0; }
  .shelf li { padding: .2rem 0; }
</style>
<h1>🪔 guru</h1>
<form method="post" action="/ask">
  <input name="q" maxlength="${MAX_QUERY}" placeholder="Ask your library&hellip;" autofocus>
  <button>Ask</button>
</form>
${body}
<p class="note"><label>Add a book (PDF or EPUB, up to ${Math.round(MAX_UPLOAD / 1024 / 1024)}MB)
  <input type="file" accept=".pdf,.epub" id="f"></label> <span id="s"></span></p>
<script>
  // The file is the whole request body — no multipart, so the server needs no parser for it.
  document.getElementById("f").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const s = document.getElementById("s");
    s.textContent = "uploading\\u2026";
    const r = await fetch("/upload?name=" + encodeURIComponent(file.name), {
      method: "PUT", body: file,
    });
    s.textContent = await r.text();
    if (r.ok) setTimeout(() => location.reload(), 1500);
  };
</script>
<p class="note"><a href="/export">Download your library</a> &middot;
  <form method="post" action="/delete" style="display:inline">
    <input name="confirm" placeholder="type DELETE" size="12">
    <button>Delete everything</button>
  </form></p>`;

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
        ? `<li>${escape(j.filename)} — <span class="note">could not be read: ${escape(j.error ?? "")}</span></li>`
        : `<li>${escape(j.filename)} — <span class="note">${j.state}&hellip;</span></li>`,
    );

  const shelved = books.map((b) => `<li>${escape(b.title)} — ${escape(b.author)}</li>`);
  return `<ul class="shelf note">${[...pending, ...shelved].join("")}</ul>`;
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
    // sniffed. The name itself never becomes a path — see the generated destination below.
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

    const hits = await rerank(query, await search(db, await expandQuery(query)));
    if (!hits.length) return send(200, PAGE("<p>Your library doesn't cover this.</p>"));

    const { answer, dropped } = await ask(query, hits);
    const sources = [...new Set(hits.map(cite))].map((c) => `<li>${escape(c)}</li>`).join("");
    send(
      200,
      PAGE(
        `<h2>${escape(query)}</h2>${render(answer)}` +
          `<p class="note">Retrieved: <ul class="note">${sources}</ul></p>` +
          (dropped ? `<p class="note">${dropped} claim(s) dropped: quotes unverified.</p>` : ""),
      ),
    );
  } catch (err) {
    // The pipeline calls an upstream model. A failure there is not the reader's fault and
    // must not render as an unsourced answer, so it is reported as a failure.
    console.error(err);
    send(502, PAGE("<p>Something failed upstream. Try again.</p>"));
  }
}).listen(PORT, () => console.error(`guru on http://localhost:${PORT}`));
