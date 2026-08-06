#!/usr/bin/env node
// The retrieval and answer path over HTTP.
//
//   node src/server.ts            # http://localhost:8080
//
// Libraries are per-user files, resolved per request, so isolation is by filesystem rather
// than by WHERE clause. Who the reader is comes from ./auth.ts and nowhere else.
try {
  process.loadEnvFile();
} catch {
  // no .env; env vars may still be set externally
}

import assert from "node:assert";
import SqliteDatabase from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { authenticate, basicAuthUser, isLibrarian, toWebRequest } from "./auth.ts";
import { createReadStream, createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askedToday, cite, libraryPath, recordAsk, search, userLibrary } from "./store.ts";
import { ask, expandQuery, plainDashes, rerank } from "./llm.ts";
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
 * Composed answers a guest may have, per address, ever.
 *
 * Five is enough to form a real opinion: ask something the shelf covers well, something it
 * covers badly, and something it does not cover at all, and the decline is the interesting
 * one. It is not a daily allowance, because a reading room that resets every midnight is a
 * free tier, and this is a demonstration.
 */
const GUEST_ASKS = Number(process.env.GURU_GUEST_ASKS ?? 5);

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
    execFileSync(process.execPath, ["-e", "import('./src/auth.ts')"], {
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
    () => boot({ GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:hunter2" }),
    "single-user with a password must boot",
  );

  // A username that cannot be a filename would only fail on the request that first tried to
  // open its library, which is a 500 for the reader rather than a refusal to deploy.
  assert.throws(
    () => boot({ GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:hunter2,not a name:pw" }),
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
    () => boot({ GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:hunter2", GURU_GUEST: "not a name" }),
    /GURU_GUEST is not a usable username/,
  );
  assert.throws(
    () => boot({ GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:hunter2", GURU_GUEST: "reader" }),
    /must not match/,
    "the guest must not be able to shadow a credentialed reader",
  );
  assert.doesNotThrow(
    () => boot({ GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:hunter2", GURU_GUEST: "guest" }),
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

  const over = join(tmp, "over.bin");
  await assert.rejects(receive(genBody(64) as any, over, 8 * 1024), /too large/);
  assert.equal(existsSync(over), false, "an over-cap upload left its partial file behind");
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
const logStmt = logdb.prepare("insert into log (user, event, q) values (?, ?, ?)");
const logEvent = (user: string, event: string, q: string) => {
  try {
    logStmt.run(user, event, q);
  } catch {}
};

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
// chrome a shared reading room must not offer. Both are chrome only; the routes refuse for
// themselves.
const PAGE = (body = "", librarian = true, guest = false) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>guru</title>
<meta name="theme-color" content="#f3efe3">
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
</style>
<div class="sheet">
<header>
  <!-- The eclipse. A ring drawn as two subpaths under evenodd, the inner circle pushed down
       and right so the corona thins toward the bottom-right and thickens opposite, the way a
       disc slightly off-centre lets more light past one side. The bead sits where the ring
       runs thinnest, the last point of light before totality. -->
  <svg class="mark" viewBox="0 0 64 64" aria-hidden="true">
    <path class="corona" fill-rule="evenodd"
      d="M 5 32 A 27 27 0 1 1 59 32 A 27 27 0 1 1 5 32 Z
         M 11 33.5 A 23 23 0 1 1 57 33.5 A 23 23 0 1 1 11 33.5 Z"/>
    <circle class="bead" cx="51.5" cy="46.5" r="3"/>
  </svg>
  <h1>guru</h1>
  <!-- Shakkei, borrowed scenery: a garden composes the landscape beyond its wall into its
       own view without ever owning it. This does the same with books. -->
  <p class="tagline">A garden of borrowed words.</p>
</header>
<form class="ask" method="post" action="/ask">
  <input name="q" maxlength="${MAX_QUERY}" placeholder="Ask ${guest ? "the library" : "your library"}&hellip;" autofocus>
  <button class="alt" formaction="/find" title="Passages only, no composed answer">Find</button>
  <button>Ask</button>
</form>
<div id="out"><div id="hist"></div>${body}</div>
<footer>
  ${guest
    ? `<span class="note">You are reading as a guest, with ${GUEST_ASKS} composed answers to spend. Find is free and uncounted.</span>`
    : `${librarian
        ? `<label class="file">Add a book
    <input type="file" accept=".pdf,.epub" id="f"></label>
  <span class="note" id="s"></span>
  <a class="note" href="/export">Export</a>`
        : ""}
  <form method="post" action="/delete">
    <input name="confirm" placeholder="type DELETE">
    <button>Delete all</button>
  </form>`}
</footer>
</div>
<script>
  // Progressive enhancement: without this the form posts normally and the page renders the
  // whole answer at once. With it, answers stack newest-first and stay on the page.
  //
  // History is per device, in localStorage, newest first. Deliberately not on the server:
  // what the operator's log holds is announced at /export, and this owes the reader the
  // same page they left.
  const form = document.querySelector("form.ask"), hist = document.getElementById("hist");
  const KEY = "guru-history";
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
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

  // A tapped citation opens the page it points at, right under the quotation, with the
  // quoted words marked. Delegated from the container so restored history entries work too.
  document.getElementById("out").addEventListener("click", async (ev) => {
    const c = ev.target.closest(".answer cite");
    if (!c) return;
    const open = c.parentElement.querySelector(".context");
    if (open) { open.remove(); return; }
    // "Title, with, commas, Author, p. 58-60": locator and author are the last two parts.
    const parts = c.textContent.split(", ");
    if (parts.length < 3) return;
    const title = parts.slice(0, -2).join(", ");
    const pageNo = (parts[parts.length - 1].match(/\\d+/) || [])[0];
    if (!pageNo) return;
    let d;
    try {
      const r = await fetch("/context?title=" + encodeURIComponent(title) + "&page=" + pageNo);
      d = await r.json();
    } catch { return; }
    if (!d.text) return;
    const div = document.createElement("div");
    div.className = "context";
    div.textContent = d.text;
    // Mark the quoted words, tolerant of the whitespace differences chunking introduces.
    const quote = (c.parentElement.querySelector("p") || {}).textContent || "";
    const words = quote.trim().split(/\\s+/);
    if (words.length > 3) {
      try {
        const pat = words.map((w) => w.replace(/[.*+?^$()|[\\]\\\\{}]/g, "\\\\$&")).join("\\\\s+");
        div.innerHTML = div.innerHTML.replace(new RegExp(pat), (s) => "<mark>" + s + "</mark>");
      } catch {}
    }
    c.after(div);
    div.querySelector("mark")?.scrollIntoView({ block: "nearest" });
  });

  form.addEventListener("submit", async (e) => {
    const q = form.q.value.trim();
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
          body: new URLSearchParams({ q }),
        });
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
        body: new URLSearchParams({ q }),
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
if (process.argv.includes("--selfcheck")) {
  assert.match(PAGE("", true), /Add a book/);
  assert.doesNotMatch(PAGE("", false), /Add a book/);
  assert.doesNotMatch(PAGE("", false), /href="\/export"/);
  assert.match(PAGE("", false), /action="\/delete"/, "a reader may still delete their own library");
  assert.doesNotMatch(PAGE("", false), /getElementById\("f"\)\.onchange/, "no handler for an absent picker");
  // The reading room. A guest sees no door that moves books or destroys a shared shelf.
  for (const gone of [/Add a book/, /href="\/export"/, /action="\/delete"/]) {
    assert.doesNotMatch(PAGE("", true, true), gone, `guest chrome must not offer ${gone}`);
  }
  assert.match(PAGE("", true, true), /reading as a guest/);
  assert.match(PAGE("", true, true), /composed answers to spend/, "a guest is told what they have");
  assert.match(PAGE("", true, true), /formaction="\/find"/, "Find stays open to guests");
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
        name: "guru",
        short_name: "guru",
        description: "A study companion for your own library that never misquotes.",
        start_url: "/",
        display: "standalone",
        background_color: "#14150f",
        theme_color: "#f3efe3",
        icons: [{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
      }),
    );
  }
  if (req.method === "GET" && (req.url === "/icon-180.png" || req.url === "/icon-512.png")) {
    try {
      const png = readFileSync(join("assets", req.url.slice(1)));
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=604800" });
      return void res.end(png);
    } catch {
      return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  }
  // The magic link: valid credentials in the query become a year-long cookie and a clean
  // redirect, so an installed web app never shows a password prompt. The credential is
  // checked by the exact same timing-safe path as the Basic header. The URL does pass
  // through proxy logs, which is the price of a link a person can simply tap; rotate the
  // password if a link ever leaks.
  if (req.method === "GET" && req.url?.startsWith("/login")) {
    const u = new URL(req.url, "http://x");
    const b64 = Buffer.from(`${u.searchParams.get("u") ?? ""}:${u.searchParams.get("p") ?? ""}`).toString("base64");
    if (!basicAuthUser(`Basic ${b64}`)) return send(401, PAGE("<p>That link is not valid.</p>", false, true));
    res.writeHead(302, {
      location: "/",
      "set-cookie": `guru=${b64}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
    return void res.end();
  }

  const auth = await authenticate(req);
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
  const page = (html = "") => PAGE(html, librarian, guest);

  if (req.method === "GET" && req.url === "/") return send(200, page(shelf(user)));

  // The page a citation lives on, for reading a quotation in its surroundings. Title and
  // page arrive from the client's parse of the citation line; an unknown pair is just an
  // empty result, not an error worth a page.
  if (req.method === "GET" && req.url?.startsWith("/context")) {
    const u = new URL(req.url, "http://x");
    const title = u.searchParams.get("title") ?? "";
    const p = Number(u.searchParams.get("page"));
    logEvent(user, "context", `${title}, p. ${p}`);
    let row: { t: string; ps: string; pe: string } | undefined;
    if (title && Number.isFinite(p)) {
      const db = userLibrary(user);
      // Longest covering chunk: overlap means two chunks can span the page, and the longer
      // one carries more of the surroundings, which is the whole point here.
      row = db
        .prepare(
          "select c.text t, c.page_start ps, c.page_end pe from chunks c join books b on c.book_id = b.id " +
            "where b.title = ? and cast(c.page_start as integer) <= ? and cast(c.page_end as integer) >= ? " +
            "order by length(c.text) desc limit 1",
        )
        .get(title, p, p) as { t: string; ps: string; pe: string } | undefined;
      db.close();
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return void res.end(
      JSON.stringify(row ? { text: row.t, page_start: row.ps, page_end: row.pe } : { text: "" }),
    );
  }

  // Retrieval without composition: hybrid search only, no answer model in the loop, so it
  // costs next to nothing per use and stays open to guests.
  if (req.method === "POST" && req.url === "/find") {
    const q = new URLSearchParams(await body(req)).get("q")?.trim() ?? "";
    if (!q) return send(400, page("<p>Ask something.</p>"));
    if (q.length > MAX_QUERY) return send(413, page("<p>That question is too long.</p>"));
    logEvent(user, "find", q);
    const db = userLibrary(user);
    const hits = (await search(db, q)).slice(0, 8);
    db.close();
    const items = hits
      .map(
        (h) =>
          `<blockquote><p>${escape(h.text.length > 500 ? h.text.slice(0, 500) + "…" : h.text)}</p>` +
          `<cite>${escape(cite(h).slice(1, -1))}</cite></blockquote>`,
      )
      .join("");
    const html = items
      ? `<p class="note">Passages only; no answer was composed.</p><div class="answer">${items}</div>`
      : "<p>Nothing in the library reads close to that.</p>";
    if ((req.headers.accept ?? "").includes("application/json")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return void res.end(JSON.stringify({ html }));
    }
    return send(200, page(`<h2>${escape(q)}</h2>${html}`));
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
        "content-disposition": `attachment; filename="guru-${user}.json"`,
      });
      return void res.end(JSON.stringify({ user, asks, note: "Questions are logged with your username so the operator can review usage. The books are the librarian's." }, null, 2));
    }
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
    // The reading room is shared; its shelf stays, whoever is passing through.
    if (guest) return send(403, page("<p>The reading room is shared, so its shelf stays. Sign in for a library of your own.</p>"));
    const form = new URLSearchParams(await body(req));
    // Irreversible and one request away from the ask form, so it takes a deliberate word
    // rather than a bare POST.
    if (form.get("confirm") !== "DELETE") return send(400, page("<p>Type DELETE to confirm.</p>"));

    for (const j of listJobs(jobs, user, 1000)) await rm(j.path, { force: true });
    jobs.prepare("delete from jobs where user_id = ?").run(user);
    // -wal and -shm hold data too; leaving them behind would seed the next database of the
    // same name with the deleted reader's writes.
    for (const suffix of ["", "-wal", "-shm"]) await rm(libraryPath(user) + suffix, { force: true });
    return send(200, page("<p>Your library and its history are gone.</p>"));
  }

  if (req.method !== "POST" || req.url !== "/ask") return send(404, page("<p>Not found.</p>"));

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
            `For a library of your own, <a href="mailto:alandevaney@gmail.com">ask for an account</a>.</p>`,
        ),
      );
    }
  }

  const query = new URLSearchParams(await body(req)).get("q")?.trim() ?? "";
  if (!query) return send(400, page("<p>Ask something.</p>"));
  if (query.length > MAX_QUERY) return send(413, page("<p>That question is too long.</p>"));
  logEvent(user, "ask", query);
  // Counted before the work and after validation: the model calls happen whether or not the
  // pipeline finds anything, and a failed question that refunds its slot is a free retry loop.
  if (guest) {
    deviceBump.run(device.id);
    quotaBump.run(clientAddress(req));
  }

  try {
    const db = userLibrary(user);
    // Counted before the work, not after: the cost is incurred whether or not the pipeline
    // finds an answer, and a failed question that refunds its slot is a free retry loop.
    if (askedToday(db) >= MAX_ASKS) {
      db.close();
      return send(429, page(`<p>That's ${MAX_ASKS} questions today. Back tomorrow.</p>`));
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
      if (!streaming) return send(200, page(none));
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

    const { answer, synopsis, dropped, declined } = await ask(query, hits);
    // A decline means nothing retrieved bore on the question, so listing what was read under
    // "Passages consulted" would claim a relevance the answer just denied.
    const shelfNote = declined ? "" : consulted;
    const note = dropped
      ? `<p class="note">${dropped} claim${dropped > 1 ? "s" : ""} dropped: the quotation could not be verified.</p>`
      : "";
    // Set apart from the passages on purpose. It is the model's own summary, and the one
    // thing this page must never do is let its own prose look like somebody's book.
    const lead = synopsis ? `<p class="synopsis">${escape(synopsis)}</p>` : "";
    const composed = `${lead}<div class="answer">${render(answer)}</div>`;

    if (!streaming) {
      return send(200, page(`<h2>${escape(query)}</h2>${composed}${shelfNote}${note}`));
    }
    emit("answer", { html: composed + shelfNote + note });
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
      send(502, page(failed));
    }
  }
}).listen(PORT, () => console.error(`guru on http://localhost:${PORT}`));
