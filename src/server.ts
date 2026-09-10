#!/usr/bin/env node
// The retrieval and answer path over HTTP.
//
//   node src/server.ts            # http://localhost:8080
//
// Libraries are per-user files, resolved per request, so isolation is by filesystem rather
// than by WHERE clause. Who the reader is comes from ./auth.ts and nowhere else.
try {
  if (process.env.GURU_NO_DOTENV !== "1") process.loadEnvFile();
} catch {
  // no .env; env vars may still be set externally
}

import { profile, ENGINE_ROOT, PYTHON as PY, SIDECAR, broaden } from "./profile.ts";
import { datedReading, monthDayIn, MONTHS } from "./reading.ts";
import { excerpt } from "./excerpt.ts";
import assert from "node:assert";
import SqliteDatabase from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { authenticate, basicAuthUser, isLibrarian, isOperator, linkToken, tokenUser, readers, sessionCookie, toWebRequest } from "./auth.ts";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { askedToday, bookPdf, BookSelectionError, cite, libraryPath, listBooks, recordAsk, search, selectedBook, userLibrary, type Hit, type LibraryBook } from "./store.ts";
import { ask, plainDashes } from "./llm.ts";
import { retrieveQuestion } from "./retrieval.ts";
import { bookLink, browseBook, detailsFor, picker, selection } from "./library.ts";
import { SourceChanged, sourceBook, sourceContext, streamPdf } from "./source.ts";
import { createRequire } from "node:module";
import { countActive, enqueue, listJobs, openJobs } from "./jobs.ts";

const PDFJS_ROOT = join(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"), "..");
const PORT = Number(process.env.PORT ?? 8080);

const UPLOADS = process.env.GURU_UPLOADS ?? "data/uploads";
const MAX_UPLOAD = Number(process.env.GURU_MAX_UPLOAD ?? 100 * 1024 * 1024);
/** Fair-use cap from SPEC.md, counted against books already held plus books in flight. */
const MAX_BOOKS = Number(process.env.GURU_MAX_BOOKS ?? 50);
const ACCEPTED = [".pdf", ".epub"];

/** Materialized copies of stored PDFs, one file per book, so poppler-less fitz has a real path
 * to open. Same sidecar-subprocess boundary as ingest: never render a PDF in the server's own
 * process. Filenames are book ids, not reader input, so there is nothing here to path-traverse. */
const PDF_CACHE = process.env.GURU_PDF_CACHE ?? "data/pdf-cache";

/** The reader's copy of a book's PDF on disk, written once and reused by size (a re-ingest of
 * the same title overwrites it). undefined when the book has no stored PDF (EPUB, or missing). */
function materializePdf(db: SqliteDatabase.Database, user: string, identity: string | number, revision?: string) {
  const row = bookPdf(db, identity, revision);
  if (!row) return undefined;
  const hash = createHash("sha256").update(row.pdf).digest("hex").slice(0, 20);
  const path = join(PDF_CACHE, `${user}-${row.id}-${hash}.pdf`);
  if (!existsSync(path) || statSync(path).size !== row.pdf.length) {
    mkdirSync(PDF_CACHE, { recursive: true });
    writeFileSync(path, row.pdf);
  }
  return { path, pageOffset: row.page_offset };
}

/**
 * Questions per reader per UTC day.
 *
 * Not a nicety: an answer costs roughly $0.04 in model calls (four rerank batches plus the
 * answer), so an uncapped reader on a ~$12/month plan turns a profit into a loss somewhere
 * around ten questions a day. This has to exist before there is anything to bill.
 */
const MAX_ASKS = Number(process.env.GURU_MAX_ASKS ?? 40);

/**
 * Composed answers a guest may have, per address, ever.
 *
 * Five is enough to form a real opinion: ask something the shelf covers well, something it
 * covers badly, and something it does not cover at all, and the decline is the interesting
 * one. It is not a daily allowance, because a reading room that resets every midnight is a
 * free tier, and this is a demonstration.
 */
const GUEST_ASKS = Number(process.env.GURU_GUEST_ASKS ?? 5);

/**
 * A deployment that is a showcase rather than a workspace.
 *
 * The public instance is something to be tried, not operated: the shelf is fixed and the
 * only interesting verbs are Find and Ask. Drawing "Add a book", "Export" and "Delete all"
 * on it invites a visitor to reach for controls that are not theirs, and puts a destructive
 * one within a typed word of the ask box on a page strangers are meant to poke at.
 *
 * Chrome only, and deliberately so. The routes already refuse for themselves, which is what
 * makes them safe; this only stops drawing doors. The operator keeps every one of them by
 * hand, and any deployment that does not set this keeps the buttons too.
 */
const DEMO = !profile.showControls || process.env.GURU_DEMO === "1" || process.env.GURU_DEMO === "true";

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
  const closed = new Promise<void>((resolve) => out.once("close", resolve));
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
    // Opening the file is asynchronous. Wait for close so it cannot appear after removal.
    out.once("error", () => {});
    out.destroy();
    await closed;
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
function citationMarkup(hit: Hit, label = escape(cite(hit).slice(1, -1))) {
  return `<cite><button type="button" class="source" data-chunk="${hit.id}" data-book="${hit.book_id ?? ""}" data-revision="${hit.revision ?? ""}" data-page="${escape(String(hit.page_start))}" data-title="${escape(hit.title)}" aria-expanded="false">${label}</button></cite>`;
}
function render(answer: string, hits: Hit[] = []) {
  const sources = new Map(hits.map((hit) => [escape(cite(hit).slice(1, -1)), hit]));
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
            ? `<blockquote><p>${m[1]}</p>${sources.has(m[2]) ? citationMarkup(sources.get(m[2])!, m[2]) : `<cite>${m[2]}</cite>`}</blockquote>`
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
    //
    // This is also the only place that can tell the model's prose from the author's, which is
    // why the dashes are flattened here rather than upstream: `quoted` decides it per line, so
    // a quotation keeps whatever punctuation its author used and the sentences around it get
    // the plainer comma. Doing it any earlier would have to guess.
    const cleaned = quoted ? line.replace(/^&gt; ?/, "") : plainDashes(line.replace(/^[.,;:]\s*/, ""));
    // A prose line with no word in it is left over from splicing, usually a lone dash or the
    // tail of punctuation from a sentence a quotation already carried away.
    if (!quoted && !/[\p{L}\p{N}]/u.test(cleaned)) continue;
    buf.push(cleaned);
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
  assert.equal(render("> quote\n-\n> another"),
    "<blockquote><p>quote</p></blockquote>\n<blockquote><p>another</p></blockquote>",
    "a wordless prose line is dropped, not rendered as an empty paragraph");
  // Dashes: the author keeps theirs, the model does not keep its own. Only this function can
  // tell the two apart, because only here is a line known to be a quotation or not.
  assert.equal(
    render("> a quoted line—with the author's dash\nthe model's line—with its own"),
    "<blockquote><p>a quoted line—with the author's dash</p></blockquote>\n<p>the model's line, with its own</p>",
  );
  assert.match(render('<script>alert("x")</script>'), /&lt;script&gt;/);

  // The guest allowance follows the browser, so the cookie that carries it has to be
  // unforgeable: an id this server never issued must not open a fresh bucket, and neither
  // must somebody else's id with the signature left off.
  {
    const secret = "a".repeat(64);
    const id = "0".repeat(32);
    const sig = signDevice(id, secret);
    assert.equal(readDevice(`gd=${id}.${sig}`, secret), id, "a signature we issued is accepted");
    assert.equal(readDevice(`other=1; gd=${id}.${sig}; x=2`, secret), id, "found among other cookies");
    assert.equal(readDevice(`gd=${id}.${sig}`, "b".repeat(64)), undefined, "signed with another key");
    assert.equal(readDevice(`gd=${id}.${"f".repeat(32)}`, secret), undefined, "forged signature");
    assert.equal(readDevice(`gd=${id}`, secret), undefined, "unsigned id");
    assert.equal(readDevice(`gd=${"1".repeat(32)}.${sig}`, secret), undefined, "another id, our signature");
    assert.equal(readDevice(undefined, secret), undefined, "no cookie at all");
    // Every id gets a distinct signature, or one leaked cookie would open all of them.
    assert.notEqual(signDevice("1".repeat(32), secret), sig);
  }

  // The synopsis is the model's own words and must be escaped like any other untrusted text,
  // since it is the one part of the page that is neither a quotation nor written by us.
  assert.match(escape('<img onerror="x">'), /&lt;img onerror=&quot;x&quot;&gt;/);

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
    execFileSync(process.execPath, ["-e", `import(${JSON.stringify(new URL("./auth.ts", import.meta.url).href)})`], {
      env: { ...process.env, NODE_ENV: "production", CLERK_SECRET_KEY: "", GURU_ORIGINS: "", GURU_SINGLE_USER: "", GURU_GUEST: "", ...env },
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
    () => boot({ GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:correct-horse-battery" }),
    "single-user with a password must boot",
  );

  // A username that cannot be a filename would only fail on the request that first tried to
  // open its library, which is a 500 for the reader rather than a refusal to deploy.
  assert.throws(
    () => boot({ GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:correct-horse-battery,not a name:pw" }),
    /not user:password/,
    "a username that is not a usable filename must refuse to boot",
  );
  assert.throws(
    () => boot({ GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "nopassword" }),
    /not user:password/,
    "an entry with no password must refuse to boot",
  );
  // The reading room's name is a filename too, and it must never shadow a real reader.
  assert.throws(
    () => boot({ GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:correct-horse-battery", GURU_GUEST: "not a name" }),
    /GURU_GUEST is not a usable username/,
  );
  assert.throws(
    () => boot({ GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:correct-horse-battery", GURU_GUEST: "reader" }),
    /must not match/,
    "the guest must not be able to shadow a credentialed reader",
  );
  assert.doesNotThrow(
    () => boot({ GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:correct-horse-battery", GURU_GUEST: "guest" }),
    "a reading room alongside real readers must boot",
  );

  // The credential check itself. Wrong password, wrong scheme, and absent header must all
  // fail; only an exact pair passes, and it answers with the reader it names.
  const who = (h: string | undefined) => basicAuthUser(h, ["ada:s3cret", "lin:h0rse"]);
  const header = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;
  assert.equal(who(header("ada:s3cret")), "ada");
  // The whole point of the list: the second credential is a different reader, not the first
  // one's library handed to someone else.
  assert.equal(who(header("lin:h0rse")), "lin");
  assert.equal(who(header("ada:wrong")), undefined);
  assert.equal(who(header("lin:s3cret")), undefined, "passwords must not be interchangeable");
  assert.equal(who(header("ada:s3cret ")), undefined, "trailing whitespace must not pass");
  assert.equal(who(header("other:s3cret")), undefined);
  assert.equal(who(undefined), undefined);
  assert.equal(who("Bearer abc"), undefined);
  assert.equal(basicAuthUser(header("ada:s3cret"), []), undefined, "no credential configured means no way in");

  // Uploading runs a parser on a file the app keeps, and exporting hands back every book in
  // one file. Naming a librarian closes both doors to everybody else while leaving the asking
  // open, which is the whole point of giving somebody a login to a library they do not own.
  assert.equal(isLibrarian("ada", ["ada"]), true);
  assert.equal(isLibrarian("lin", ["ada"]), false, "a reader is not a librarian");
  assert.equal(isLibrarian("lin", []), true, "unset means a one-person deployment, everyone");

  // Uploads are capped while streaming, not from content-length, because the header is the
  // client's word. A body that keeps going must be cut off and its partial file removed.
  const tmp = mkdtempSync(join(tmpdir(), "guru-up-"));
  const genBody = async function* (n: number) {
    for (let i = 0; i < n; i++) yield Buffer.alloc(1024);
  };
  const small = join(tmp, "ok.bin");
  assert.equal(await receive(genBody(4) as any, small, 8 * 1024), 4096);
  assert.equal(statSync(small).size, 4096);

  for (const limit of [0, 8 * 1024]) {
    const over = join(tmp, `over-${limit}.bin`);
    await assert.rejects(receive(genBody(64) as any, over, limit), /too large/);
    assert.equal(existsSync(over), false, "an over-cap upload left its partial file behind");
  }
  rmSync(tmp, { recursive: true, force: true });

  // No exit here: the PAGE assertions further down must run too. This block used to exit,
  // which left every selfcheck below it dead code that always "passed".
}

const jobs = openJobs();

/**
 * The operator's usage log: who asked what, when, in one queryable file. This reverses the
 * old stance that question text is never stored, so the /export note says so plainly and
 * every reader deserves to be told. Failures are swallowed: the log must never take an
 * answer down with it.
 */
const logdb = new SqliteDatabase(process.env.GURU_LOG_DB ?? "data/log.db");
logdb.pragma("journal_mode = WAL");
logdb.exec("create table if not exists log (at text default (datetime('now')), user text, event text, q text)");
for (const column of ["flag", "outcome", "event_key"]) {
  if (!(logdb.pragma("table_info(log)") as { name: string }[]).some((c) => c.name === column)) logdb.exec(`alter table log add column ${column} text`);
}
logdb.exec("create unique index if not exists log_event_key on log(event_key)");
logdb.exec("create table if not exists reader_privacy (user text primary key, logging integer not null check(logging in (0, 1)))");
const loggingEnabled = (user: string) => (logdb.prepare("select logging from reader_privacy where user = ?").get(user) as { logging: number } | undefined)?.logging !== 0;
const logStmt = logdb.prepare("insert into log (user, event, q, flag, event_key) values (?, ?, ?, ?, ?)");
const logEvent = (user: string, event: string, q: string) => {
  try {
    if (!loggingEnabled(user)) return undefined;
    const token = randomBytes(16).toString("hex");
    logStmt.run(user, event, q, suspicious(q), token);
    return { token, user };
  } catch { return undefined; }
};
const logOutcome = (event: { token: string; user: string } | undefined, outcome: string) => {
  if (!event) return;
  try { logdb.prepare("update log set outcome = ? where event_key = ? and user = ?").run(outcome, event.token, event.user); } catch {}
};
const suspicious = (q: string) => /\b(ignore|disregard|forget)\b.{0,40}\b(instructions?|prompt|rules|above)\b|\bsystem prompt\b|\bjailbreak\b|<\/?(question|system)>/i.test(q) ? "steering" : "";
const failures = new Map<string, { count: number; until: number }>();
function authFailed(ip: string) {
  const now = Date.now();
  for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
  const prior = failures.get(ip);
  if (prior) prior.count++;
  else if (failures.size < 10_000) failures.set(ip, { count: 1, until: now + 900_000 });
}
function blocked(ip: string) {
  const value = failures.get(ip);
  return !!value && value.count >= 10 && value.until > Date.now();
}

/**
 * The guest allowance, counted per browser and bounded per address.
 *
 * Per address alone was wrong in both directions. An office, a university, a conference and
 * anyone behind CGNAT share one address, so the first curious person there spent the
 * allowance for everybody. Meanwhile one person with a phone and a laptop looked like two.
 *
 * So the allowance belongs to the browser: a signed id in a cookie, one bucket each. That
 * cannot stand alone, because clearing a cookie asks the server for a fresh id and the
 * server will always give one. The address therefore keeps a ceiling: it may hand out
 * `GUEST_DEVICES` allowances before it stops, which leaves a shared network usable and
 * still bounds the cookie-clearing loop. A guest is refused when EITHER counter is spent.
 *
 * Both live in the log database so there is still one file to back up. Unlike the log, a
 * failure here must NOT be swallowed: a quota that silently stops counting is an open bar.
 */
const GUEST_DEVICES = Number(process.env.GURU_GUEST_DEVICES ?? 4);
logdb.exec("create table if not exists guest_quota (ip text primary key, n integer not null default 0, first_at text default (datetime('now')), last_at text)");
logdb.exec("create table if not exists guest_device (id text primary key, n integer not null default 0, first_at text default (datetime('now')), last_at text)");
logdb.exec("create table if not exists kv (k text primary key, v text not null)");

const quotaGet = logdb.prepare("select n from guest_quota where ip = ?");
const quotaBump = logdb.prepare(
  "insert into guest_quota (ip, n, last_at) values (?, 1, datetime('now')) " +
    "on conflict(ip) do update set n = n + 1, last_at = datetime('now') returning n",
);
const deviceGet = logdb.prepare("select n from guest_device where id = ?");
const deviceBump = logdb.prepare(
  "insert into guest_device (id, n, last_at) values (?, 1, datetime('now')) " +
    "on conflict(id) do update set n = n + 1, last_at = datetime('now') returning n",
);

/**
 * The key that signs device ids.
 *
 * Kept in the database rather than the environment so it survives a restart without another
 * variable to set and to forget. Rotating it is a deliberate act: every guest gets a fresh
 * allowance, which is why it is not simply regenerated at boot.
 */
const deviceSecret = (() => {
  const row = logdb.prepare("select v from kv where k = 'device_secret'").get() as { v: string } | undefined;
  if (row) return row.v;
  const v = randomBytes(32).toString("hex");
  logdb.prepare("insert into kv (k, v) values ('device_secret', ?)").run(v);
  return v;
})();

/** The browser's id, or a new one. `fresh` means the cookie still has to be sent back. */
function deviceId(req: IncomingMessage): { id: string; fresh: boolean } {
  const id = readDevice(req.headers.cookie, deviceSecret);
  return id ? { id, fresh: false } : { id: randomBytes(16).toString("hex"), fresh: true };
}

const deviceCookie = (id: string) =>
  `gd=${id}.${signDevice(id, deviceSecret)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax` +
  (process.env.NODE_ENV === "production" ? "; Secure" : "");


// A declaration, not a const arrow: the selfcheck block runs at module scope above this
// line and needs it hoisted.
function signDevice(id: string, secret: string) {
  return createHmac("sha256", secret).update(id).digest("hex").slice(0, 32);
}

/**
 * The id in a `gd` cookie, if it is one this server issued. Pure, so it is testable without
 * a database: the secret lives in one and the selfcheck runs before any is opened.
 *
 * Signed so the value cannot be edited into somebody else's bucket, or into an id that was
 * never issued at all. It identifies a browser and nothing else: no fingerprint, no address
 * in the cookie, and the id is meaningless outside this one table.
 */
export function readDevice(cookie: string | undefined, secret: string): string | undefined {
  const m = cookie?.match(/(?:^|;\s*)gd=([0-9a-f]{32})\.([0-9a-f]{32})/);
  if (!m) return undefined;
  const [, id, sig] = m;
  const expect = signDevice(id, secret);
  // Constant-time: the signature is derived from a secret, and comparing it with === leaks a
  // prefix oracle, which is enough to forge one byte at a time.
  if (sig.length !== expect.length) return undefined;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expect)) ? id : undefined;
}

/**
 * The visitor's address, as observed by our own proxy.
 *
 * Traefik APPENDS the peer it saw to any X-Forwarded-For the client sent, so the last entry
 * is the one our infrastructure observed and the earlier ones are the client's to invent.
 * Taking the last is what makes the ceiling worth having. With no header at all we are not
 * behind the proxy, so the socket is the truth.
 */
function clientAddress(req: IncomingMessage) {
  const xff = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return chain.length ? chain[chain.length - 1] : (req.socket.remoteAddress ?? "unknown");
}

/**
 * One page, set like a garden rather than a chat window.
 *
 * The typographic decision that drives the rest is unchanged: quotations are the product and
 * the model's prose is connective tissue, so passages are set larger and in full ink and the
 * sentences linking them are smaller and quieter.
 *
 * The dress is a garden's. Washi ground, sumi ink, moss for the marks of structure, and one
 * vermilion bead, spent once. The mark is an eclipse: one body passes in front of another and
 * what reaches you is the light around its edge, which is the whole arrangement here. The
 * model occludes; the books are what you actually read. Nothing is fetched: no webfont, no
 * script from anywhere, so the page renders whole on the first byte.
 */
// `librarian` decides whether the controls that move books are drawn; `guest` strips the
// chrome a shared reading room must not offer; `demo` strips them from everybody, operator
// included, because a showcase is for reading. All three are chrome only; the routes refuse
// for themselves.
type SourceChoice = { books: LibraryBook[]; selected?: number; compare?: number[] };
function sourceLabel(book: LibraryBook) {
  let source = book.source;
  try { source = new URL(source).pathname; } catch {}
  return `${book.title}, ${book.author} (${basename(source) || "copy"}, ${book.id})`;
}
function bookLabel(book: LibraryBook, books: LibraryBook[]) {
  return books.filter((b) => b.title === book.title && b.author === book.author).length < 2
    ? `${book.title}, ${book.author}` : sourceLabel(book);
}
const scopeNote = (books: LibraryBook[] = []) => books.length ? `<p class="note scope-note">From ${books.map((book) => escape(sourceLabel(book))).join("<br>")}</p>` : "";
const loggedQuestion = (query: string, books: LibraryBook[] = []) => books.length ? `${query}\n[Source: ${books.map(sourceLabel).join(" | ")}]` : query;
const PAGE = (body = "", librarian = true, guest = false, demo = DEMO, meta = "", reader = "", choice?: SourceChoice) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(profile.name)}</title>
<meta name="theme-color" content="${profile.themeColor}">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="apple-touch-icon" href="/icon-180.png">
<style>
  :root {
    /* Washi, sumi, and moss. The green does the work rubric used to do, marking structure
       and never colouring body text; vermilion remains, but only as the seal, stamped once. */
    --paper: #f3efe3; --ink: #26241d; --quiet: #7d7a6c; --rule: #ddd6c2; --field: #eae4d2;
    --moss: #6f8264; --seal: #b5472e;
    /* Old-style serifs, in order of how good they look. No webfont: a page about patient
       reading should not wait on a network round trip to show its first line. */
    --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "URW Palladio L", "Book Antiqua", Georgia, serif;
    --small: ui-monospace, "SF Mono", "IBM Plex Mono", "DejaVu Sans Mono", monospace;
  }
  @media (prefers-color-scheme: dark) {
    /* The garden at night. Moss lifts toward jade so it still reads as green against the
       dark; the seal warms the way vermilion does by lamplight. */
    :root { --paper: #14150f; --ink: #e4e1d2; --quiet: #8a8878; --rule: #2b2e23; --field: #1c1e15;
            --moss: #8fa583; --seal: #cf6a45; }
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

  header { text-align: center; margin-bottom: clamp(2.5rem, 7vh, 4.5rem); animation: rise .8s ease-out both; }
  /* The corona brightens and dims on the pace of slow breathing. Eleven seconds is long
     enough that you notice only if you stop and watch, which is the correct amount of
     attention for a mark to ask for. The bead does not move; it is the fixed point. */
  .mark { width: 64px; height: 64px; }
  .mark .corona { fill: var(--ink); opacity: .82; animation: breathe-ink 11s ease-in-out infinite; }
  .mark .bead { fill: var(--seal); }
  @keyframes breathe-ink { 0%, 100% { opacity: .82; } 50% { opacity: .58; } }
  @keyframes breathe { 0%, 100% { opacity: .25; } 50% { opacity: .7; } }
  @media (prefers-reduced-motion: reduce) { .mark .corona { animation: none; } }

  h1 { margin: .9rem 0 .3rem; font-size: 1.5rem; font-weight: 400; letter-spacing: .34em;
       text-indent: .34em; text-transform: lowercase; }
  .tagline { margin: 0; color: var(--quiet); font-size: .9375rem; font-style: italic; text-wrap: balance; }

  /* The question sits on a ruled line, like writing on a page, not inside a widget. */
  .ask { display: flex; gap: .75rem; align-items: baseline;
         border-bottom: 1px solid var(--rule); padding-bottom: .5rem; margin-bottom: 3rem; }
  .ask input { flex: 1; min-width: 0; border: 0; background: transparent; color: inherit;
               font: italic 1.125rem/1.6 var(--serif); padding: .3rem 0; }
  .ask input::placeholder { color: var(--quiet); opacity: .8; }
  .ask input:focus { outline: none; }
  .ask:focus-within { border-bottom-color: var(--moss); }
  .ask button { border: 0; background: none; color: var(--quiet); cursor: pointer;
                font: .75rem/1 var(--small); letter-spacing: .18em; text-transform: uppercase; }
  .ask button:hover { color: var(--moss); }
  .scope { display: flex; gap: .75rem; align-items: center; margin-bottom: 1rem; }
  .scope label { flex-shrink: 0; }
  .scope select { flex: 1; min-width: 0; max-width: 100%; min-height: 44px; padding: .5rem;
                  border: 1px solid var(--rule); background: var(--paper); color: var(--ink); font: 1rem/1.4 var(--serif); }
  .scope select:focus-visible { outline: 2px solid var(--moss); outline-offset: 2px; }

  h2 { font-size: 1.25rem; font-weight: 400; font-style: italic; color: var(--quiet);
       margin: 0 0 2rem; text-wrap: balance; }

  /* Inverted hierarchy: the passage is the payload, the prose around it is scaffolding. The
     margin rule is moss now, a reed laid beside somebody else's words. */
  blockquote { position: relative; margin: 2.5rem 0; padding-left: 1.4rem; }
  blockquote::before {
    content: ""; position: absolute; left: 0; top: .34em; bottom: .34em; width: 2px;
    background: var(--moss); opacity: .6;
  }
  blockquote p { margin: 0; font-size: 1.1875rem; line-height: 1.62; text-wrap: pretty; }
  blockquote p::before { content: "\\201C"; margin-left: -.42em; }
  blockquote p::after { content: "\\201D"; }
  /* Set in the book face; half these titles are Gutenberg catalogue entries and the mono
     face ran a locator to three lines. A tap opens the page the citation points at. */
  cite { display: block; margin-top: .55rem; color: var(--quiet); opacity: .85;
         font: italic .8125rem/1.45 var(--serif); letter-spacing: 0; text-wrap: pretty; }
  .answer cite { cursor: pointer; }
  .answer cite:hover { color: var(--moss); opacity: 1; }
  .context { white-space: pre-wrap; margin: .75rem 0 0; padding: .75rem 1rem;
             background: var(--field); border: 1px solid var(--rule); border-radius: 2px;
             font-size: .8125rem; line-height: 1.7; max-height: 18rem; overflow: auto; }
  .context mark { background: transparent; box-shadow: inset 0 -0.45em rgba(111,130,100,.3); color: inherit; }
  .context .pdf-page { display: block; max-width: 100%; margin-top: .6rem; border-radius: 2px; }
  /* Between passages, three stones in the gravel where the paragraphus used to stand. */
  blockquote + p:not(:empty)::before {
    content: "\\00B7 \\00B7 \\00B7"; color: var(--moss); opacity: .8; letter-spacing: .3em;
    margin-right: .6em; font-size: .9em;
  }
  .answer > p { color: var(--quiet); font-size: .9375rem; text-wrap: pretty; }

  /* The model's own summary: an editor's standfirst, ruled off, never dressed as a book. */
  .synopsis { margin: 0 0 2.5rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--rule);
              font-size: 1.0625rem; line-height: 1.7; text-wrap: pretty; }
  .note { color: var(--quiet); font-size: .8125rem; }
  .note a { color: inherit; text-underline-offset: .2em; }
  details { margin-top: 2.5rem; }
  summary { cursor: pointer; font: .6875rem/1.6 var(--small); letter-spacing: .12em;
            text-transform: uppercase; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: "+ "; color: var(--moss); }
  details[open] summary::before { content: "\\2212 "; }
  summary:hover { color: var(--ink); }
  ul.shelf { list-style: none; padding: 0; margin: 3rem 0 0; }
  ul.shelf li { padding: .35rem 0; border-bottom: 1px solid var(--rule); font-size: .875rem;
                color: var(--quiet); text-wrap: pretty; }
  ul.shelf li:last-child { border-bottom: 0; }

  /* Stacked question-and-answer entries, newest on top, ruled apart like a ledger. */
  .qa { padding-top: 2rem; border-top: 1px solid var(--rule); margin-top: 2rem; }
  .qa:first-child { padding-top: 0; border-top: 0; margin-top: 0; }

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
  .waiting { animation: breathe 3.2s ease-in-out infinite; }
  .waiting::after { content: "\\2026"; }
  .answer, h2 { animation: rise .5s ease-out both; }
  @media (prefers-reduced-motion: reduce) { .answer, h2, header { animation: none; } }
  @keyframes rise { from { opacity: 0; transform: translateY(.4rem); } to { opacity: 1; transform: none; } }
  .source { color: inherit; font: inherit; text-align: left; background: none; border: 0; padding: .25rem 0; cursor: pointer; }
  .source:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--moss); outline-offset: 4px; }
  .ask input:focus-visible { outline: 2px solid var(--moss); outline-offset: 4px; }
  .reading { white-space: pre-wrap; }
  .library-tools { margin-bottom: 1rem; }
  .library-tools input, .library-tools select { width: 100%; min-height: 44px; font: inherit; }
  .library-tools label { display: block; margin-top: .6rem; }
  .library-tools summary { padding-block: .6rem; cursor: pointer; }
  .book-passages { padding-left: 1.3rem; }
  .book-passages li { margin-block: .7rem; }
  .context nav { display: flex; flex-wrap: wrap; gap: .6rem; }
  .context nav button, .context nav a, #saved-passages { min-height: 44px; }
  dialog { max-width: min(90vw, 42rem); background: var(--paper); color: var(--ink); border: 1px solid var(--rule); border-radius: 6px; }
  dialog::backdrop { background: #0008; }
  #bookmark-list p { display: flex; gap: .8rem; align-items: center; }
  #bookmark-list a { flex: 1; overflow-wrap: anywhere; }
  #bookmark-list button { min-height: 44px; }
  #clear-history { max-width: 100%; min-height: 44px; }

  .log-wrap { overflow-x: auto; }
  table.log { border-collapse: collapse; font-size: .8125rem; width: 100%; }
  .log th, .log td { text-align: left; padding: .4rem; border-bottom: 1px solid var(--rule); }
  .ask button { min-height: 44px; min-width: 44px; }
  @media (prefers-reduced-motion: reduce) { .waiting { animation: none; } }
</style>
${profile.styles ? '<link rel="stylesheet" href="/theme.css">' : ""}
<div class="sheet" data-reader="${escape(reader)}" data-history="${escape(profile.historyKey)}">
<header>
  <!-- The eclipse. A ring drawn as two subpaths under evenodd, the inner circle pushed down
       and right so the corona thins toward the bottom-right and thickens opposite, the way a
       disc slightly off-centre lets more light past one side. The bead sits where the ring
       runs thinnest, the last point of light before totality. -->
  ${profile.mark ? '<img class="mark" src="/mark.svg" alt="">' : `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true">
    <path class="corona" fill-rule="evenodd"
      d="M 5 32 A 27 27 0 1 1 59 32 A 27 27 0 1 1 5 32 Z
         M 11 33.5 A 23 23 0 1 1 57 33.5 A 23 23 0 1 1 11 33.5 Z"/>
    <circle class="bead" cx="51.5" cy="46.5" r="3"/>
  </svg>`}
  <h1>${escape(profile.name)}</h1>
  <!-- Shakkei, borrowed scenery: a garden composes the landscape beyond its wall into its
       own view without ever owning it. This does the same with books. -->
  <p class="tagline">${escape(profile.tagline)}</p>
</header>
${choice?.books.length ? `<div class="scope"><label for="book" class="note">Search in</label>
<select id="book" name="book" form="ask-form"><option value="">All books</option>${choice.books.map((b) =>
  `<option value="${b.id}" data-tradition="${escape(detailsFor(b)?.tradition || "")}" data-edition="${escape(detailsFor(b)?.edition || "")}"${b.id === choice.selected ? " selected" : ""}>${escape(bookLabel(b, choice.books))}</option>`).join("")}</select></div>${picker(choice.books, choice.compare)}` : ""}
<form id="ask-form" class="ask" method="post" action="/ask">
  <input name="q" aria-label="Question for your library" maxlength="${MAX_QUERY}" placeholder="Ask ${guest ? "the library" : "your library"}&hellip;" autofocus>
  <button class="alt" formaction="/find" title="Passages only, no composed answer">Find</button>
  <button>Ask</button>
</form>
<p class="note meta" role="status">${escape(meta)}</p>
<div id="out"><div id="hist"></div>${body}</div>
<footer>
  <span class="note">${loggingEnabled(reader) ? "Questions are stored for operator review." : "Question logging is off."} Browser history stays on this device.</span>
  ${guest
    ? `<span class="note">You are reading as a guest, with ${GUEST_ASKS} composed answers to spend. Find is free and uncounted.</span>`
    : demo
      ? `<span class="note">A fixed shelf, open to read and search.</span>`
      : `${librarian
        ? `<label class="file">Add a book
    <input type="file" accept=".pdf,.epub" id="f"></label>
  <span class="note" id="s"></span>
  <a class="note" href="/export">Export</a>`
        : ""}
  <form method="post" action="/delete">
    <input aria-label="Type DELETE to delete your library" name="confirm" placeholder="type DELETE">
    <button>Delete all</button>
  </form>`}
  ${!guest ? '<a class="note" href="/privacy">Privacy and history</a>' : ""}
  <button type="button" id="saved-passages" class="note">Bookmarks</button>
</footer>
<dialog id="bookmark-dialog"><h2>Saved passages</h2><div id="bookmark-list"></div><form method="dialog"><button>Close</button></form></dialog>
</div>
<script src="/library.js" defer></script>
<script>
  // Progressive enhancement: without this the form posts normally and the page renders the
  // whole answer at once. With it, answers stack newest-first and stay on the page.
  //
  // History is per device, in localStorage, newest first. Deliberately not on the server:
  // what the operator's log holds is announced at /export, and this owes the reader the
  // same page they left.
  const form = document.querySelector("form.ask"), hist = document.getElementById("hist");
  const KEY = ${JSON.stringify(profile.historyKey)} + ":" + document.querySelector(".sheet").dataset.reader;
  if (document.getElementById("deleted") || document.getElementById("history-cleared")) { try { localStorage.removeItem(KEY); localStorage.removeItem(${JSON.stringify(profile.historyKey)}); } catch {} }
  const load = () => { try { const rows = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(rows) ? rows.filter((p) => p && typeof p.q === "string" && typeof p.html === "string").slice(0, 50) : []; } catch { return []; } };
  // Fifty answers is more page than anyone scrolls and localStorage has a quota; the tail
  // falls off silently. Saving can also fail outright (private mode), and history is not
  // worth breaking the answer over.
  const save = (h) => { try { localStorage.setItem(KEY, JSON.stringify(h.slice(0, 50))); } catch {} };
  // The stored html came from this server's own renderer, so re-inserting it is the same
  // trust decision the live path already makes. The question is text and is set as text.
  const entry = (q, html) => {
    const a = document.createElement("article");
    a.className = "qa";
    a.innerHTML = "<h2></h2>" + html;
    a.querySelector("h2").textContent = q;
    return a;
  };
  let past = load();
  for (const p of past) hist.appendChild(entry(p.q, p.html));

  const clear = document.createElement("p");
  clear.innerHTML = '<a href="#" class="note">clear history</a>';
  clear.firstChild.onclick = (ev) => {
    ev.preventDefault();
    past = [];
    save(past);
    hist.replaceChildren();
    clear.remove();
  };
  if (past.length) hist.after(clear);

  document.getElementById("out").addEventListener("click", async (ev) => {
    const source = ev.target.closest("button.source");
    if (!source) return;
    const cite = source.closest("cite");
    const existing = cite.nextElementSibling;
    if (existing?.classList.contains("context")) { existing.remove(); source.setAttribute("aria-expanded", "false"); return; }
    const div = document.createElement("div");
    div.className = "context";
    div.setAttribute("role", "region");
    div.setAttribute("aria-label", "Source context");
    div.textContent = "Opening source...";
    cite.after(div);
    source.setAttribute("aria-expanded", "true");
    const params = new URLSearchParams({ book: source.dataset.book, revision: source.dataset.revision || "", chunk: source.dataset.chunk });
    const show = async () => {
      try {
        const response = await fetch("/context?" + params);
        const data = await response.json();
        if (!response.ok) { div.textContent = data.error || "Source unavailable."; return; }
        div.replaceChildren();
        const text = document.createElement("p");
        text.textContent = data.text;
        div.append(text);
        const controls = document.createElement("nav");
        controls.setAttribute("aria-label", "Source navigation");
        for (const [label, id] of [["Previous passage", data.previous], ["Next passage", data.next]]) {
          const button = document.createElement("button");
          button.type = "button"; button.textContent = label; button.disabled = !id;
          button.onclick = () => { params.set("chunk", id); show(); };
          controls.append(button);
        }
        if (data.pdf) {
          const link = document.createElement("a");
          const target = new URLSearchParams({ book: data.book, revision: data.revision, page: data.page_start });
          link.href = "/reader?" + target;
          link.textContent = "Read original PDF";
          controls.append(link);
        }
        const savePassage = document.createElement("button");
        savePassage.type = "button"; savePassage.textContent = "Bookmark passage";
        savePassage.onclick = () => window.dispatchEvent(new CustomEvent("bookmark-passage", { detail: data }));
        controls.append(savePassage);
        div.append(controls);
      } catch { div.textContent = "Could not open the source. Close it and try again."; }
    };
    await show();
  });

  form.addEventListener("submit", async (e) => {
    const q = form.q.value.trim();
    const book = document.getElementById("book")?.value || "";
    const payload = new URLSearchParams({ q, book });
    for (const option of document.getElementById("compare")?.selectedOptions || []) payload.append("compare", option.value);
    if (!q) return;
    e.preventDefault();

    // Two submit buttons, one form: Find retrieves passages with no model in the loop.
    if (e.submitter && e.submitter.getAttribute("formaction") === "/find") {
      const cur = entry(q, '<p class="note waiting">searching the shelves</p>');
      hist.prepend(cur);
      form.q.value = "";
      try {
        const r = await fetch("/find", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: payload,
        });
        if (!(r.headers.get("content-type") || "").includes("application/json")) {
          document.open(); document.write(await r.text()); document.close(); return;
        }
        const d = await r.json();
        cur.innerHTML = "<h2></h2>" + d.html;
        cur.querySelector("h2").textContent = q;
        past.unshift({ q, html: d.html, t: Date.now() });
        save(past);
      } catch { const w = cur.querySelector(".waiting"); if (w) w.textContent = "could not reach the server"; }
      return;
    }

    const cur = entry(q, '<p class="note waiting">searching your library</p>');
    hist.prepend(cur);
    form.q.value = "";
    const waiting = () => cur.querySelector(".waiting");

    let res;
    try {
      res = await fetch("/ask", {
        method: "POST",
        headers: { accept: "text/event-stream", "content-type": "application/x-www-form-urlencoded" },
        body: payload,
      });
    } catch { waiting().textContent = "could not reach the server"; return; }

    // The daily cap and an over-long question come back as ordinary status codes with a
    // whole page, so fall back to letting the browser render it.
    if (!res.ok || !(res.headers.get("content-type") || "").includes("event-stream")) {
      document.open(); document.write(await res.text()); document.close(); return;
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
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
        if (name === "quota") document.querySelector(".meta").textContent = data.text;
        // Only the count is used here. Whether the passages are worth listing depends on the
        // answer, which has not been written yet, so the server sends the list with it.
        if (name === "passages" && waiting()) waiting().textContent = data.text + ", composing an answer";
        if (name === "answer") {
          cur.innerHTML = "<h2></h2>" + data.html;
          cur.querySelector("h2").textContent = q;
          past.unshift({ q, html: data.html, t: Date.now() });
          save(past);
        }
      }
    }
    if (waiting()) waiting().textContent = "the answer did not arrive";
  });

  // The file is the whole request body, no multipart, so the server needs no parser for it.
  // Absent for a reader who may not add books, in which case there is nothing to wire up.
  const picker = document.getElementById("f");
  if (picker) picker.onchange = async (e) => {
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

// Second selfcheck block, because PAGE is defined below the first one and a const cannot be
// read before it exists. The controls are chrome: a reader who has seen the page once knows
// the URLs, so the routes refuse the request themselves and this only stops drawing buttons
// that would 403.
const blankPage = PAGE();
const codeHash = (tag: string) => createHash("sha256").update(blankPage.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? "").digest("base64");
const CSP = `default-src 'self'; script-src 'self' 'sha256-${codeHash("script")}'; style-src 'self' 'sha256-${codeHash("style")}'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;

if (process.argv.includes("--selfcheck")) {
  assert.match(PAGE("", true), /Add a book/);
  assert.doesNotMatch(PAGE("", false), /Add a book/);
  assert.doesNotMatch(PAGE("", false), /href="\/export"/);
  assert.match(PAGE("", false), /action="\/delete"/, "a reader may still delete their own library");
  // The uploader wires itself only if the picker exists, so an absent one is inert. The
  // assertion that used to sit here looked for `getElementById("f").onchange`, which this
  // file has never contained, so it could not fail. Test the guard that does the work.
  assert.match(PAGE("", true), /if \(picker\) picker\.onchange/, "the uploader is guarded on the picker");
  assert.doesNotMatch(PAGE("", false), /type="file"/, "a reader who cannot add books gets no picker");
  // The reading room. A guest sees no door that moves books or destroys a shared shelf.
  for (const gone of [/Add a book/, /href="\/export"/, /action="\/delete"/]) {
    assert.doesNotMatch(PAGE("", true, true), gone, `guest chrome must not offer ${gone}`);
  }
  assert.match(PAGE("", true, true), /reading as a guest/);
  assert.match(PAGE("", true, true), /composed answers to spend/, "a guest is told what they have");
  assert.match(PAGE("", true, true), /formaction="\/find"/, "Find stays open to guests");

  // A showcase deployment draws none of it, for anyone. The operator still has every route;
  // this only stops putting a destructive control a typed word away from the ask box on a
  // page whose whole purpose is that strangers poke at it.
  for (const gone of [/Add a book/, /href="\/export"/, /action="\/delete"/, /type="file"/]) {
    assert.doesNotMatch(PAGE("", true, false, true), gone, `a demo must not draw ${gone}`);
  }
  assert.match(PAGE("", true, false, true), /A fixed shelf/, "and says why the controls are absent");
  // Off by default: a private deployment is a workspace and keeps its controls.
  assert.match(PAGE("", true, false, false), /Add a book/, "not a demo unless it says so");

  // An old hostname is sent to the canonical one, path and query intact. The canonical host
  // must never redirect: that is a loop, and a loop is the whole site gone.
  assert.equal(redirectTarget("guru.gainful.work", "/x?q=1", "guru.alanj.dev"), "https://guru.alanj.dev/x?q=1");
  assert.equal(redirectTarget("guru.alanj.dev", "/", "guru.alanj.dev"), undefined, "the canonical host stays put");
  assert.equal(redirectTarget("guru.alanj.dev:443", "/", "guru.alanj.dev"), undefined, "a port is not a different host");
  assert.equal(redirectTarget("anything", "/", undefined), undefined, "unset means nothing redirects");
  assert.equal(redirectTarget("", "/", "guru.alanj.dev"), undefined, "no Host header, no guess");
  // The healthcheck calls in on the loopback address. Redirecting it away cost an outage:
  // every probe failed, the container went unhealthy, and Traefik stopped routing to a
  // process that was serving correctly the whole time.
  assert.equal(redirectTarget("127.0.0.1:8080", "/", "guru.alanj.dev"), undefined, "the healthcheck is not a browser");
  assert.equal(redirectTarget("localhost:8080", "/", "guru.alanj.dev"), undefined, "nor is localhost");
  assert.equal(redirectTarget("[::1]:8080", "/", "guru.alanj.dev"), undefined, "nor is the v6 loopback");
  assert.equal(redirectTarget("10.0.0.4", "/", "guru.alanj.dev"), undefined, "nor anything calling by address");
  // History renders into its own container above the server-rendered body (the shelf), so
  // past answers stack without displacing it. The body must stay inside #out for the
  // non-JS POST path, which renders the whole answer server-side.
  assert.match(PAGE("SHELF"), /<div id="out"><div id="hist"><\/div>SHELF<\/div>/);
  assert.match(PAGE(""), /localStorage/, "history lives in the reader's browser");
  assert.match(PAGE(""), /guru-history/, "history is namespaced to guru");
  // The eclipse replaced the old circle mark; the bead is the one vermilion on the sheet.
  assert.match(PAGE(""), /class="corona"/);
  assert.match(PAGE(""), /class="bead"/);
  assert.doesNotMatch(PAGE(""), /enso/, "the old mark is gone");
  // Today's passage is gone; the front page is the shelf and the question.
  assert.doesNotMatch(PAGE(""), /Today.s passage/);

  // The address the quota counts is the one OUR proxy observed, which is the last entry in
  // the chain. A client that invents a header must not be able to mint itself new visitors.
  const addr = (h: Record<string, unknown>, socket = "10.0.0.9") =>
    clientAddress({ headers: h, socket: { remoteAddress: socket } } as any);
  assert.equal(addr({ "x-forwarded-for": "203.0.113.7" }), "203.0.113.7");
  assert.equal(
    addr({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }),
    "203.0.113.7",
    "a spoofed leading entry must not become the identity",
  );
  assert.equal(addr({}), "10.0.0.9", "with no proxy in front, the socket is the truth");

  console.error("server selfcheck ok");
  process.exit(0);
}

/** What the reader has, and what is still being read in. */
function shelf(user: string) {
  const db = userLibrary(user);
  const books = listBooks(db);
  db.close();

  const pending = listJobs(jobs, user)
    .filter((j) => j.state !== "done")
    .map((j) =>
      j.state === "failed"
        ? `<li>${escape(j.filename)}, <span class="note">could not be read: ${escape(j.error ?? "")}</span></li>`
        : `<li>${escape(j.filename)}, <span class="note">${j.state}&hellip;</span></li>`,
    );

  const shelved = books.map((b) => `<li data-shelf-book><a href="${bookLink(b)}">${escape(b.title)}</a>, ${escape(b.author)}</li>`);

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

function reading(user: string) {
  const settings = profile.dailyReading;
  if (!settings) return "";
  const db = userLibrary(user);
  const rows = db.prepare("select c.id, c.book_id, c.chunk_id, c.text, c.page_start, c.page_end, b.title, b.author, b.paginated, b.revision, c.text t, c.page_start ps from chunks c join books b on c.book_id = b.id where b.title = ?").all(settings.book) as (Hit & { t: string; ps: string })[];
  db.close();
  const { month, day } = monthDayIn(process.env.GURU_TZ ?? settings.timezone);
  const entry = datedReading(rows, month, day);
  if (!entry) return "";
  return `<section class="reflection answer"><p class="note">${escape(settings.label)}, ${MONTHS[month]} ${day}</p><h2>${escape(entry.title)}</h2><blockquote class="reading"><p>${escape(entry.text)}</p>${citationMarkup(entry.row)}</blockquote></section>`;
}

/**
 * The host this deployment answers to. Everything else 301s here.
 *
 * The reading room moved from gainful.work to alanj.dev and the old name still has a DNS
 * record pointing at the same box, so it still arrives. Redirecting rather than dropping it
 * keeps any link anyone already has, and keeps one canonical URL for anything that indexes
 * the page. Done in the app rather than in proxy labels because Coolify rewrites those on
 * every deploy, and a redirect that survives exactly until the next deploy is worse than
 * none. Unset, nothing redirects, which is what a local or private deployment wants.
 */
const CANONICAL_HOST = process.env.GURU_CANONICAL_HOST;

/**
 * Where a request should be sent instead, or nothing if it is already in the right place.
 *
 * Pure, because the failure mode is a redirect loop that takes the site down completely and
 * that is not something to find out in production. The port is stripped before comparing:
 * a Host header carries one and the configured name does not.
 */
export function redirectTarget(host: string | undefined, url: string | undefined, canonical: string | undefined) {
  const h = String(host ?? "").split(":")[0];
  if (!canonical || !h || h === canonical) return undefined;
  // An address rather than a name means the caller is inside: the container healthcheck
  // fetches 127.0.0.1, and sending it away made every probe fail, which made the container
  // unhealthy, which made the proxy stop routing to a server that was answering fine. A
  // redirect is for a browser that arrived at the wrong public name; nothing else.
  if (h === "localhost" || h.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return undefined;
  return `https://${canonical}${url ?? "/"}`;
}

const handleRequest = async (req: IncomingMessage, res: import("node:http").ServerResponse) => {
  res.setHeader("content-security-policy", CSP);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cache-control", "private, no-store");
  if (process.env.NODE_ENV === "production") res.setHeader("strict-transport-security", "max-age=31536000");
  // Before anything else, including auth: an old host should not prompt for a password to
  // reach a page it is only going to be sent away from.
  const moved = redirectTarget(req.headers.host, req.url, CANONICAL_HOST);
  if (moved) {
    res.writeHead(301, { location: moved });
    return void res.end();
  }

  // Resolved once per request and attached to whatever HTML goes back, so a guest's first
  // page view is what issues the id rather than their first question. Without that the
  // cookie would arrive on the 302 after an ask and the very first request of every visit
  // would count as a new browser.
  const device = deviceId(req);
  const send = (code: number, html: string) =>
    res
      .writeHead(code, {
        "content-type": "text/html; charset=utf-8",
        ...(device.fresh ? { "set-cookie": deviceCookie(device.id) } : {}),
      })
      .end(html);

  // Installable-web-app plumbing, before authentication on purpose: Safari fetches the
  // manifest and icons without credentials, and /login is how credentials arrive at all.
  // None of it exposes a word of any library.
  if (req.method === "GET" && req.url === "/manifest.webmanifest") {
    res.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "public, max-age=86400" });
    return void res.end(
      JSON.stringify({
        name: profile.name,
        short_name: profile.shortName,
        description: profile.description,
        start_url: "/",
        display: "standalone",
        background_color: profile.backgroundColor,
        theme_color: profile.themeColor,
        icons: [{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
      }),
    );
  }
  if (req.method === "GET" && (req.url === "/icon-180.png" || req.url === "/icon-512.png")) {
    try {
      const png = readFileSync(join(profile.assets, req.url.slice(1)));
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=604800" });
      return void res.end(png);
    } catch {
      return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  }
  if (req.method === "GET" && (req.url === "/mark.svg" || req.url === "/theme.css")) {
    const file = req.url === "/mark.svg" ? profile.mark : profile.styles;
    if (!file) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": req.url === "/mark.svg" ? "image/svg+xml" : "text/css; charset=utf-8" });
    return void res.end(readFileSync(file));
  }
  if (req.method === "GET") {
    const path = new URL(req.url ?? "/", "http://local").pathname;
    let asset: string | undefined;
    if (["/reader.js", "/reader.css", "/library.js"].includes(path)) asset = join(ENGINE_ROOT, "web", path.slice(1));
    const vendor = /^\/pdfjs\/((?:build\/pdf(?:\.worker)?\.mjs)|(?:web\/pdf_viewer\.css)|(?:(?:cmaps|standard_fonts|wasm)\/[a-zA-Z0-9_.-]+))$/.exec(path);
    if (vendor) asset = join(PDFJS_ROOT, vendor[1]);
    if (asset && existsSync(asset)) {
      const type = /\.m?js$/.test(asset) ? "text/javascript" : asset.endsWith(".css") ? "text/css" : asset.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      return void createReadStream(asset).pipe(res);
    }
  }
  const ip = clientAddress(req);
  if (blocked(ip)) return send(429, PAGE("<p>Too many failed sign-ins. Try again later.</p>", false, true));
  if (req.method === "GET" && new URL(req.url ?? "/", "http://local").pathname === "/login") {
    const query = new URL(req.url!, "http://local").searchParams;
    const name = query.get("u") ?? "";
    const user = query.has("t") ? tokenUser(name, query.get("t") ?? "") : basicAuthUser(`Basic ${Buffer.from(`${name}:${query.get("p") ?? ""}`).toString("base64")}`);
    if (!user) { authFailed(ip); return send(401, PAGE("<p>That link is not valid.</p>", false, true)); }
    res.writeHead(302, {
      location: "/",
      "set-cookie": `__Host-${profile.cookieName}=${user}.${linkToken(user)}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
    return void res.end();
  }
  if (["POST", "PUT", "DELETE"].includes(req.method ?? "") && req.headers["sec-fetch-site"] === "cross-site") return send(403, PAGE("<p>Request origin rejected.</p>", false, true));

  const auth = await authenticate(req);
  if (auth.kind === "respond" && auth.status === 401 && (req.headers.authorization !== undefined || sessionCookie(req.headers.cookie) !== undefined)) authFailed(ip);
  if (auth.kind === "respond") {
    // Clerk's headers carry the session cookie and redirect target; forward them as given.
    return res.writeHead(auth.status, Object.fromEntries(auth.headers)).end();
  }
  const user = auth.userId;
  const guest = auth.guest === true;

  // Both doors that move books rather than answers. Enforced on the routes, not by hiding the
  // controls: the upload is a plain PUT and the export a plain GET, so anyone who has seen the
  // page once can call them again by hand. A guest is never a librarian whatever the env says,
  // because the reading room's shelf belongs to the operator, not to whoever walked in.
  const librarian = !guest && isLibrarian(user);
  const page = (html = "", meta = "", choice?: SourceChoice) => PAGE(html, librarian, guest, DEMO, meta, user, choice);

  if (req.method === "GET" && req.url === "/") {
    const db = userLibrary(user);
    const left = Math.max(0, MAX_ASKS - askedToday(db));
    const books = listBooks(db);
    db.close();
    return send(200, page(reading(user) + shelf(user), profile.showQuota ? `${left} of ${MAX_ASKS} questions left today` : "", { books }));
  }
  if (req.url === "/privacy" || req.url === "/privacy/export" || req.url === "/privacy/clear") {
    if (guest) return send(403, page("<p>Sign in to manage personal history.</p>"));
    if (req.method === "GET" && req.url === "/privacy/export") {
      const db = userLibrary(user);
      let asks;
      try { asks = db.prepare("select at from asks order by at").all(); } finally { db.close(); }
      res.writeHead(200, { "content-type": "application/json", "content-disposition": 'attachment; filename="question-history.json"' });
      return void res.end(JSON.stringify({ user, logging: loggingEnabled(user), asks, events: logdb.prepare("select at, event, q, flag, outcome from log where user = ? order by rowid").all(user) }, null, 2));
    }
    let cleared = false;
    if (req.method === "POST") {
      const form = new URLSearchParams(await body(req));
      if (req.url === "/privacy/clear") {
        if (form.get("confirm") !== "CLEAR") return send(400, page("<p>Type CLEAR to delete question history.</p>"));
        logdb.prepare("delete from log where user = ?").run(user);
        cleared = true;
      } else if (req.url === "/privacy" && ["on", "off"].includes(form.get("logging") ?? "")) {
        logdb.prepare("insert into reader_privacy values (?, ?) on conflict(user) do update set logging = excluded.logging").run(user, form.get("logging") === "on" ? 1 : 0);
      } else return send(400, page("<p>Choose a history setting.</p>"));
    } else if (req.method !== "GET") return send(405, page("<p>Method not allowed.</p>"));
    return send(200, page(`${cleared ? '<p id="history-cleared">Question history cleared.</p>' : ""}<h2>Privacy and history</h2>
      <p>Question logging is ${loggingEnabled(user) ? "on" : "off"}. When on, the operator can read your questions and source requests.</p>
      <form method="post" action="/privacy"><button name="logging" value="${loggingEnabled(user) ? "off" : "on"}">Turn logging ${loggingEnabled(user) ? "off" : "on"}</button></form>
      <p><a href="/privacy/export">Export question history</a></p>
      <form method="post" action="/privacy/clear"><label for="clear-history">Type CLEAR to delete question history</label><input id="clear-history" name="confirm" autocomplete="off"><button>Clear question history</button></form>
      <p class="note">Clearing removes your server question log and this browser's answer history. Your books and bookmarks stay. Daily usage timestamps still enforce the question allowance. Other devices keep their own browser history. Backups expire under the operator's retention settings.</p>
      <p><a href="/">Return to library</a></p>`));
  }
  if (req.method === "GET" && new URL(req.url ?? "/", "http://local").pathname === "/log") {
    if (guest || !isOperator(user)) return send(403, page("<p>Operator only.</p>"));
    const query = new URL(req.url!, "http://local").searchParams;
    const who = query.get("user");
    const limit = Math.max(1, Math.min(2000, Number(query.get("limit")) || 200));
    type Event = { at: string; user: string; event: string; q: string; outcome: string | null };
    const rows = (who ? logdb.prepare("select * from log where user = ? order by rowid desc limit ?").all(who, limit) : logdb.prepare("select * from log order by rowid desc limit ?").all(limit)) as Event[];
    const table = rows.map((r) => `<tr><td>${escape(r.at)}</td><td>${escape(r.user)}</td><td>${escape(r.event)}</td><td>${escape(r.q)}</td><td>${escape(r.outcome ?? "")}</td></tr>`).join("");
    const links = readers().map((name) => `<li>${escape(name)} <a href="/login?u=${encodeURIComponent(name)}&amp;t=${linkToken(name)}">Sign-in link</a></li>`).join("");
    return send(200, page(`<h2>Usage log</h2><div class="log-wrap"><table class="log"><thead><tr><th>Time</th><th>Reader</th><th>Action</th><th>Question</th><th>Outcome</th></tr></thead><tbody>${table}</tbody></table></div><details><summary>Reader links</summary><ul>${links}</ul></details>`));
  }

  const sourceUrl = new URL(req.url ?? "/", "http://local");
  if (["GET", "HEAD"].includes(req.method ?? "") && ["/context", "/pdf-meta", "/source.pdf", "/reader", "/pdf-page", "/book"].includes(sourceUrl.pathname)) {
    const db = userLibrary(user);
    try {
      const book = sourceBook(db, sourceUrl.searchParams.get("book"), sourceUrl.searchParams.get("revision"));
      if (sourceUrl.pathname === "/book") return send(200, page(browseBook(db, book, sourceUrl.searchParams), "", { books: listBooks(db), selected: book.id }));
      if (sourceUrl.pathname === "/source.pdf") return await streamPdf(req, res, db, book);
      if (sourceUrl.pathname === "/reader") {
        if (!book.bytes) return send(404, page("<p>The original PDF is not stored for this edition. Source text is still available from its citation.</p>"));
        res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        return send(200, readFileSync(join(ENGINE_ROOT, "web/reader.html"), "utf8").replaceAll("__READER__", escape(user)).replaceAll("__HISTORY__", escape(profile.historyKey)));
      }
      if (sourceUrl.pathname === "/pdf-meta") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ ...book, available: book.bytes > 0 }));
      }
      if (sourceUrl.pathname === "/context") {
        const row = sourceContext(db, book, sourceUrl.searchParams.get("chunk"));
        logEvent(user, "context", `${book.revision}/${row.id}`);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ ...row, book: book.id, revision: book.revision, title: book.title, author: book.author, pdf: book.bytes > 0 }));
      }
      const pdf = materializePdf(db, user, book.id, book.revision);
      const n = Number(sourceUrl.searchParams.get("page")) - book.page_offset;
      if (!pdf || !Number.isInteger(n) || n < 1) return void res.writeHead(404).end("page unavailable");
      try {
        const png = execFileSync(PY, [SIDECAR, "--render", pdf.path, String(n)], { maxBuffer: 32 * 1024 * 1024 });
        res.writeHead(200, { "content-type": "image/png" });
        return void res.end(png);
      } catch { return void res.writeHead(404).end("page unavailable"); }
    } catch (error) {
      if (error instanceof SourceChanged) return void res.writeHead(410, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
      throw error;
    } finally { db.close(); }
  }

  // Retrieval without composition: hybrid search only, no answer model in the loop, so it
  // costs next to nothing per use and stays open to guests.
  if (req.method === "POST" && req.url === "/find") {
    const form = new URLSearchParams(await body(req));
    const q = form.get("q")?.trim() ?? "";
    const db = userLibrary(user);
    try {
      const { chosen, choice } = selection(db, form);
      if (!q) return send(400, page("<p>Ask something.</p>", "", choice));
      if (q.length > MAX_QUERY) return send(413, page("<p>That question is too long.</p>", "", choice));
      logEvent(user, "find", loggedQuestion(q, chosen));
      const groups = chosen.length > 1 ? await Promise.all(chosen.map((b) => search(db, broaden(q), undefined, { literalQuery: q, bookIds: [b.id] }))) : [await search(db, broaden(q), undefined, { literalQuery: q, bookIds: chosen.length ? chosen.map((b) => b.id) : undefined })];
      const hits = groups.flatMap((hits) => hits.slice(0, chosen.length > 1 ? 3 : 8));
      const items = hits
        .map(
          (h) =>
            `<blockquote><p>${escape(excerpt(h.text, q, 500))}</p>` +
            `${citationMarkup(h)}</blockquote>`,
        )
        .join("");
      const html = scopeNote(chosen) + (items
        ? `<p class="note">Passages only; no answer was composed.</p><div class="answer">${items}</div>`
        : "<p>No passages were found in the selected sources.</p>");
      if ((req.headers.accept ?? "").includes("application/json")) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        return void res.end(JSON.stringify({ html }));
      }
      return send(200, page(`<h2>${escape(q)}</h2>${html}`, "", choice));
    } catch (error) {
      if (error instanceof BookSelectionError) return send(400, page(`<p>${escape(error.message)}</p>`, "", { books: listBooks(db) }));
      throw error;
    } finally { db.close(); }
  }

  if (req.method === "PUT" && req.url?.startsWith("/upload")) {
    const text = (code: number, msg: string) =>
      res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }).end(msg);

    if (guest) return text(403, "The reading room's shelf is fixed. Sign in to keep a library of your own.");
    if (!librarian) return text(403, "Only the librarian can add books to this library.");

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
    // The reading room is a shared identity; there is nothing in it that is any one
    // visitor's to take. A signed-in reader's own library is a different matter, below.
    if (guest) return send(403, page("<p>The reading room keeps nothing that is yours to export. Sign in for a library of your own.</p>"));
    // A reader who cannot add books has nothing of their own in the file. The corpus is the
    // librarian's, so what is actually theirs is their usage. Questions are logged with the
    // username so the operator can review usage, and this file says so rather than hiding it.
    if (!librarian) {
      const db = userLibrary(user);
      const asks = (db.prepare("select at from asks order by at").all() as { at: string }[]).map((r) => r.at);
      db.close();
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${profile.id}-${user}.json"`,
      });
      return void res.end(JSON.stringify({ user, asks, events: logdb.prepare("select at, event, q, flag, outcome from log where user = ? order by rowid").all(user), note: "Questions are logged with your username so the operator can review usage. The books are the librarian's." }, null, 2));
    }
    const directory = mkdtempSync(join(tmpdir(), "guru-export-"));
    const snapshot = join(directory, "library.db");
    try {
      const db = userLibrary(user);
      try { db.prepare("vacuum into ?").run(snapshot); } finally { db.close(); }
      const copy = new SqliteDatabase(snapshot);
      try {
        copy.exec("drop table if exists reader_events; create table reader_events (at text, event text, q text, flag text, outcome text)");
        const insert = copy.prepare("insert into reader_events values (?, ?, ?, ?, ?)");
        const rows = logdb.prepare("select at, event, q, flag, outcome from log where user = ? order by rowid").all(user) as { at: string; event: string; q: string; flag: string | null; outcome: string | null }[];
        copy.transaction(() => { for (const row of rows) insert.run(row.at, row.event, row.q, row.flag, row.outcome); })();
      } finally { copy.close(); }
      res.writeHead(200, {
        "content-type": "application/vnd.sqlite3",
        "content-disposition": `attachment; filename="${profile.id}-${user}.db"`,
      });
      const stream = createReadStream(snapshot);
      const cleanup = () => rmSync(directory, { recursive: true, force: true });
      stream.on("error", () => res.destroy()).on("close", cleanup);
      res.on("close", () => stream.destroy());
      return void stream.pipe(res);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  if (req.method === "POST" && req.url === "/delete") {
    // The reading room is shared; its shelf stays, whoever is passing through.
    if (guest) return send(403, page("<p>The reading room is shared, so its shelf stays. Sign in for a library of your own.</p>"));
    const form = new URLSearchParams(await body(req));
    // Irreversible and one request away from the ask form, so it takes a deliberate word
    // rather than a bare POST.
    if (form.get("confirm") !== "DELETE") return send(400, page("<p>Type DELETE to confirm.</p>"));

    for (const j of listJobs(jobs, user, 1000)) await rm(j.path, { force: true });
    jobs.prepare("delete from jobs where user_id = ?").run(user);
    logdb.prepare("delete from log where user = ?").run(user);
    if (existsSync(PDF_CACHE)) for (const file of readdirSync(PDF_CACHE)) if (file.startsWith(`${user}-`)) await rm(join(PDF_CACHE, file), { force: true });
    // -wal and -shm hold data too; leaving them behind would seed the next database of the
    // same name with the deleted reader's writes.
    for (const suffix of ["", "-wal", "-shm"]) await rm(libraryPath(user) + suffix, { force: true });
    return send(200, page('<p id="deleted">Your library and its question history are gone.</p>'));
  }

  if (req.method !== "POST" || req.url !== "/ask") return send(404, page("<p>Not found.</p>"));

  const form = new URLSearchParams(await body(req));
  const query = form.get("q")?.trim() ?? "";
  const db = userLibrary(user);
  let chosen: LibraryBook[] = [];
  const choice: SourceChoice = { books: [] };
  try {
    choice.books = listBooks(db);
    const selected = selection(db, form);
    chosen = selected.chosen;
    Object.assign(choice, selected.choice);
    if (!query) return send(400, page("<p>Ask something.</p>", "", choice));
    if (query.length > MAX_QUERY) return send(413, page("<p>That question is too long.</p>", "", choice));
    // A guest gets a handful of composed answers so the room can actually be judged rather
    // than just looked at. The allowance is this browser's; the address only sets a ceiling
    // on how many browsers it may hand one to. Search stays free and uncounted.
    if (guest) {
      const ip = clientAddress(req);
      const spent = (deviceGet.get(device.id) as { n: number } | undefined)?.n ?? 0;
      const fromHere = (quotaGet.get(ip) as { n: number } | undefined)?.n ?? 0;
      if (spent >= GUEST_ASKS || fromHere >= GUEST_ASKS * GUEST_DEVICES) {
        // Which limit was hit changes what the reader should do about it, so say which.
        const why =
          spent >= GUEST_ASKS
            ? `That is ${GUEST_ASKS} composed answers, which is what the reading room offers.`
            : `This network has spent what the reading room offers it.`;
        return send(
          429,
          page(
            `<p>${why} ` +
              `Find still works and costs nothing, so the shelf is still open to search. ` +
              `For a library of your own, <a href="mailto:alandevaney@gmail.com">ask for an account</a>.</p>`, "", choice,
          ),
        );
      }
    }

    const logId = logEvent(user, "ask", loggedQuestion(query, chosen));
    // Counted before the work and after validation: the model calls happen whether or not the
    // pipeline finds anything, and a failed question that refunds its slot is a free retry loop.
    if (guest) {
      deviceBump.run(device.id);
      quotaBump.run(clientAddress(req));
    }

    // Counted before the work, not after: the cost is incurred whether or not the pipeline
    // finds an answer, and a failed question that refunds its slot is a free retry loop.
    if (askedToday(db) >= MAX_ASKS) {
      return send(429, page(`<p>That's ${MAX_ASKS} questions today. Back tomorrow.</p>`, "", choice));
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

    if (profile.showQuota) emit("quota", { text: `${Math.max(0, MAX_ASKS - askedToday(db))} of ${MAX_ASKS} questions left today` });
    emit("stage", { text: "searching your library" });
    const retrieval = await retrieveQuestion(db, query, { bookIds: chosen.length ? chosen.map((b) => b.id) : undefined });
    const hits = retrieval.hits;
    if (!hits.length) {
      logOutcome(logId, "no passages");
      const none = scopeNote(chosen) + "<p>No supporting passage was found for this question.</p>";
      if (!streaming) return send(200, page(none, "", choice));
      emit("answer", { html: none });
      return void res.end();
    }

    const sources = [...new Set(hits.map(cite))].map((c) => `<li>${escape(c)}</li>`).join("");
    // What was read but not quoted: available to anyone who wants to check the work, folded
    // away from anyone who does not.
    const consulted =
      `<details class="note"><summary>Passages consulted</summary>` +
      `<ul class="shelf">${sources}</ul></details>`;
    emit("passages", { text: `reading ${hits.length} passage${hits.length > 1 ? "s" : ""}` });

    const { answer, synopsis, dropped, declined, passages } = await ask(query, hits);
    logOutcome(logId, declined ? "declined" : /^>/.test(answer) ? "answered" : "ungrounded");
    // A decline means nothing retrieved bore on the question, so listing what was read under
    // "Passages consulted" would claim a relevance the answer just denied.
    const shelfNote = declined ? "" : consulted;
    const note = dropped
      ? `<p class="note">${dropped} claim${dropped > 1 ? "s" : ""} dropped: the quotation could not be verified.</p>`
      : "";
    // Set apart from the passages on purpose. It is the model's own summary, and the one
    // thing this page must never do is let its own prose look like somebody's book.
    const lead = synopsis ? `<p class="synopsis">${escape(synopsis)}</p>` : "";
    const content = passages.length ? passages.map((p) => `<blockquote><p>${escape(p.text)}</p>${citationMarkup(p.hit)}</blockquote>`).join("") : render(answer);
    const missing = chosen.length > 1 ? chosen.filter((book) => !passages.some((p) => p.hit.book_id === book.id)).map((book) => `<p class="note">No quoted support selected from ${escape(sourceLabel(book))}. This comparison may be incomplete.</p>`).join("") : "";
    const composed = `${scopeNote(chosen)}${missing}${lead}<div class="answer">${content}</div>`;

    if (!streaming) {
      return send(200, page(`<h2>${escape(query)}</h2>${composed}${shelfNote}${note}`, "", choice));
    }
    emit("answer", { html: composed + shelfNote + note });
    res.end();
  } catch (err) {
    if (err instanceof BookSelectionError) return send(400, page(`<p>${escape(err.message)}</p>`, "", { books: listBooks(db) }));
    // The pipeline calls an upstream model. A failure there is not the reader's fault and
    // must not render as an unsourced answer, so it is reported as a failure.
    console.error(err);
    const failed = scopeNote(chosen) + "<p>Something failed upstream. Try again.</p>";
    // A stream that has already sent its headers cannot be given a status; it has to say so
    // in an event and close, or the reader watches a spinner that never resolves.
    if (res.headersSent) {
      res.write(`event: answer\ndata: ${JSON.stringify({ html: failed })}\n\n`);
      res.end();
    } else {
      send(502, page(failed, "", choice));
    }
  } finally { db.close(); }
};
createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    console.error("Request failed:", error instanceof Error ? error.message : "unknown error");
    if (res.headersSent) return void res.destroy();
    res.writeHead(error instanceof Error && error.message === "body too large" ? 413 : 500, { "content-type": "text/plain; charset=utf-8" }).end("Request could not be completed.");
  });
}).listen(PORT, process.env.HOST ?? "0.0.0.0", () => console.error(`${profile.id} on http://localhost:${PORT}`));
