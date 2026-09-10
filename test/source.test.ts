import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { addBook, bookPdf, open, search } from "../src/store.ts";
import { byteRange, sourceBook, sourceContext, SourceChanged } from "../src/source.ts";
import { PYTHON, SIDECAR } from "../src/profile.ts";

const directory = mkdtempSync(join(tmpdir(), "guru-source-"));
let child: ReturnType<typeof spawn> | undefined;
let model: ReturnType<typeof createServer> | undefined;
try {
  const pdf = execFileSync(PYTHON, [SIDECAR, "--sample", join(directory, "Writer - Sample.pdf")], { encoding: "utf8" }).trim();
  const bytes = readFileSync(pdf);
  const starter = join(directory, "starter.db");
  const db = open(starter);
  const text = "The bright red bird returns to the forest every spring.";
  const otherText = "The bright red bird returns to the river every winter.";
  for (const [source, passage] of [["first.pdf", text], ["second.pdf", otherText]]) {
    await addBook(db, { title: "Shared Title", author: "Writer", source, paginated: true, page_offset: 100,
      chunks: [{ chunk_id: 0, text: passage, page_start: 101, page_end: 101 }] }, undefined, bytes);
  }
  const hits = await search(db, "bright red bird");
  assert.equal(new Set(hits.map((h) => h.book_id)).size, 2);
  assert.equal(bookPdf(db, "Shared Title"), undefined, "ambiguous titles cannot choose a PDF");
  const first = hits.find((h) => h.book_id === 1)!;
  const reference = `book=${first.book_id}&revision=${first.revision}`;
  assert.equal(bookPdf(db, first.book_id!)?.page_offset, 100);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();

  const requests: any[] = [];
  const replies: string[] = [];
  let modelFails = false;
  let modelGate: Promise<void> | undefined;
  model = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    requests.push(JSON.parse(Buffer.concat(parts).toString()));
    if (modelGate) await modelGate;
    if (modelFails) { res.writeHead(500); res.end("fixture failure"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: replies.shift() ?? "NONE" } }] }));
  });
  await new Promise<void>((resolve) => model!.listen(0, "127.0.0.1", resolve));
  const modelPort = (model.address() as import("node:net").AddressInfo).port;

  const port = 8953;
  const base = `http://127.0.0.1:${port}`;
  const logFile = join(directory, "log.db");
  let errors = "";
  child = spawn(process.execPath, ["src/server.ts"], { env: { ...process.env,
    GURU_NO_DOTENV: "1", NODE_ENV: "development", PORT: String(port), GURU_STARTER: starter,
    GURU_USER_DIR: join(directory, "users"), GURU_LOG_DB: logFile, GURU_JOBS_DB: join(directory, "jobs.db"),
    GURU_PDF_CACHE: join(directory, "pdf-cache"), GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:very-long-test-password,other:another-long-test-password",
    GURU_LIBRARIAN: "operator", GURU_GUEST: "", GURU_DEMO: "", GURU_PROVIDER: "openai",
    OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, OPENAI_API_KEY: "stub",
  }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr!.on("data", (s) => errors += s.toString());
  const authorization = `Basic ${Buffer.from("reader:very-long-test-password").toString("base64")}`;
  const headers = { authorization };
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(errors);
    try { await fetch(base, { headers }); break; }
    catch { if (i === 100) throw new Error(errors); await new Promise((r) => setTimeout(r, 100)); }
  }
  const home = await fetch(base, { headers });
  const html = await home.text();
  assert.match(html, /<label for="book"[^>]*>Search in<\/label>/);
  assert.match(html, /<select id="book" name="book" form="ask-form">/);
  assert.match(html, /Shared Title, Writer \(first\.pdf, 1\)/, "duplicate titles include a source filename");
  assert.match(html, /Shared Title, Writer \(second\.pdf, 2\)/);
  for (const tag of ["style", "script"]) {
    const code = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))![1];
    const hash = createHash("sha256").update(code).digest("base64");
    assert(home.headers.get("content-security-policy")?.includes(`'sha256-${hash}'`));
  }
  assert.equal((await fetch(`${base}/context?${reference}&chunk=${first.id}`, { headers }).then((r) => r.json())).text, text);
  assert.equal((await fetch(`${base}/context?${reference}&chunk=99999`, { headers })).status, 410);
  assert.equal((await fetch(`${base}/context?chunk=${first.id}`, { headers })).status, 410, "legacy citations cannot silently bind to a reused id");
  assert.equal((await fetch(`${base}/pdf-meta?${reference}`, { headers }).then((r) => r.json())).available, true);
  const page = await fetch(`${base}/pdf-page?${reference}&page=101`, { headers });
  assert.equal(page.status, 200);
  assert.deepEqual(Buffer.from(await page.arrayBuffer()), execFileSync(PYTHON, [SIDECAR, "--render", pdf, "1"]));
  assert.equal((await fetch(`${base}/pdf-page?${reference}&page=1`, { headers })).status, 404);
  const head = await fetch(`${base}/source.pdf?${reference}`, { method: "HEAD", headers });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), bytes.length);
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  const partial = await fetch(`${base}/source.pdf?${reference}`, { headers: { ...headers, range: "bytes=0-99" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 0-99/${bytes.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 100));
  const suffix = await fetch(`${base}/source.pdf?${reference}`, { headers: { ...headers, range: "bytes=-31" } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-31));
  for (const range of ["bytes=999999999-", "bytes=5-3", "bytes=0-1,4-9", "items=0-2"]) {
    assert.equal((await fetch(`${base}/source.pdf?${reference}`, { headers: { ...headers, range } })).status, 416);
  }
  assert.equal((await fetch(`${base}/source.pdf?${reference}`, { headers: { ...headers, "if-none-match": head.headers.get("etag")! } })).status, 304);
  const changedValidator = await fetch(`${base}/source.pdf?${reference}`, { headers: { ...headers, range: "bytes=0-99", "if-range": '"old"' } });
  assert.equal(changedValidator.status, 200);
  assert.deepEqual(Buffer.from(await changedValidator.arrayBuffer()), bytes);
  assert.equal((await fetch(`${base}/source.pdf?${reference}`)).status, 401);
  assert.equal((await fetch(`${base}/reader?${reference}`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/pdfjs/build/pdf.worker.mjs`, { headers })).status, 200);
  assert.deepEqual(byteRange("bytes=0-999", 100), { start: 0, end: 99 });
  assert.equal(byteRange("bytes=-0", 100), null);
  assert.equal(byteRange("bytes=9007199254740993-", 100), null);
  const result = await fetch(`${base}/find`, { method: "POST", headers: { ...headers, accept: "application/json" }, body: "q=bright+red+bird" }).then((r) => r.json());
  assert.match(result.html, /class="source" data-chunk="\d+" data-book="\d+"/);
  assert.match(result.html, /<button type="button"/);
  assert.equal(requests.length, 0, "Find does not call a model");
  const scoped = await fetch(`${base}/find`, { method: "POST", headers: { ...headers, accept: "application/json" }, body: "q=bright+red+bird&book=2" }).then((r) => r.json());
  assert(scoped.html.includes(otherText));
  assert(!scoped.html.includes(text));
  assert.match(scoped.html, /data-book="2"/);
  assert(!scoped.html.includes('data-book="1"'));
  assert.match(scoped.html, /From Shared Title, Writer \(second\.pdf, 2\)/);
  const withoutJs = await fetch(`${base}/find`, { method: "POST", headers, body: "q=bright+red+bird&book=2" }).then((r) => r.text());
  assert.match(withoutJs, /<option value="2"[^>]* selected>/, "the source selection survives a normal form submission");
  for (const endpoint of ["find", "ask"]) {
    for (const book of ["9999", "1 OR 1=1", "-1"]) {
      assert.equal((await fetch(`${base}/${endpoint}`, { method: "POST", headers, body: new URLSearchParams({ q: "bird", book }) })).status, 400);
    }
  }
  for (const endpoint of ["find", "ask"]) {
    for (const q of ["", "x".repeat(10001)]) {
      const invalid = await fetch(`${base}/${endpoint}`, { method: "POST", headers, body: new URLSearchParams({ q, book: "2" }) });
      assert.equal(invalid.status, q ? 413 : 400);
      assert.match(await invalid.text(), /<option value="2"[^>]* selected>/, "query errors keep the selected source");
    }
  }
  assert.equal(requests.length, 0, "an invalid selection must not call a model");
  const usage = new Database(join(directory, "users/reader.db"), { readonly: true });
  assert.equal((usage.prepare("select count(*) n from asks").get() as { n: number }).n, 0, "invalid selections spend no question allowance");
  replies.push('The bird visits a forest in spring. "forest every spring"', "0", "[P0S0]");
  const composed = await fetch(`${base}/ask`, { method: "POST", headers: { ...headers, accept: "text/event-stream" }, body: "q=Where+does+the+bird+return%3F&book=2" }).then((r) => r.text());
  assert(composed.includes(otherText));
  assert(!composed.includes(text), "Ask cannot quote another book despite query expansion favoring it");
  assert.equal(requests.length, 3);
  assert(!JSON.stringify(requests[2]).includes(text), "the answer model receives only selected-source passages");
  assert.equal((usage.prepare("select count(*) n from asks").get() as { n: number }).n, 1);
  usage.close();
  modelFails = true;
  const failed = await fetch(`${base}/ask`, { method: "POST", headers, body: "q=bird&book=2" });
  assert.equal(failed.status, 502);
  const failurePage = await failed.text();
  assert.match(failurePage, /<option value="2"[^>]* selected>/, "upstream failure keeps the selected source for retry");
  assert.match(failurePage, /From Shared Title, Writer \(second\.pdf, 2\)/);
  modelFails = false;
  assert.equal((await fetch(`${base}/log`, { headers })).status, 403);
  const exported = await fetch(`${base}/export`, { headers }).then((r) => r.json());
  assert(exported.events.some((e: { q: string }) => e.q === "bright red bird"));
  assert(exported.events.some((e: { q: string }) => e.q.includes("[Source: Shared Title, Writer (second.pdf, 2)]")), "export retains the selected source");
  const otherHeaders = { authorization: `Basic ${Buffer.from("other:another-long-test-password").toString("base64")}` };
  await fetch(base, { headers: otherHeaders });
  const otherDb = open(join(directory, "users/other.db"));
  otherDb.prepare("update books set revision = lower(hex(randomblob(16)))").run(); otherDb.close();
  for (const route of ["context", "pdf-meta", "source.pdf", "reader", "pdf-page", "book"]) {
    const denied = await fetch(`${base}/${route}?${reference}&chunk=${first.id}&page=101`, { headers: otherHeaders });
    assert.equal(denied.status, 410); assert(!(await denied.text()).includes(text));
  }
  let release!: () => void;
  modelGate = new Promise<void>((resolve) => { release = resolve; setTimeout(resolve, 5000).unref(); });
  const initialCalls = requests.length;
  replies.push("bird", "0", "[P0S0]");
  const pendingAsk = fetch(`${base}/ask`, { method: "POST", headers, body: "q=bird&book=2" });
  for (let i = 0; requests.length === initialCalls; i++) {
    assert(i < 100, "pending Ask did not reach fixture model"); await new Promise((r) => setTimeout(r, 20));
  }
  await fetch(`${base}/privacy/clear`, { method: "POST", headers, body: "confirm=CLEAR" });
  await fetch(`${base}/find`, { method: "POST", headers: otherHeaders, body: "q=bird" });
  release(); modelGate = undefined; await (await pendingAsk).text();
  const others = await fetch(`${base}/privacy/export`, { headers: otherHeaders }).then((r) => r.json());
  assert.equal(others.events.find((e: any) => e.event === "find").outcome, null, "an earlier Ask must not update another reader's reused log row");
  await fetch(`${base}/find`, { method: "POST", headers, body: "q=bird" });
  const privacy = await fetch(`${base}/privacy`, { headers }).then((r) => r.text());
  assert.match(privacy, /Export question history/);
  const before = await fetch(`${base}/privacy/export`, { headers }).then((r) => r.json());
  assert(before.events.length > 0);
  assert.equal((await fetch(`${base}/privacy/clear`, { method: "POST", headers, body: "confirm=wrong" })).status, 400);
  assert.equal((await fetch(`${base}/privacy/clear`, { method: "POST", headers, body: "confirm=CLEAR" })).status, 200);
  const after = await fetch(`${base}/privacy/export`, { headers }).then((r) => r.json());
  assert.equal(after.events.length, 0); assert.equal(after.asks.length, before.asks.length);
  await fetch(`${base}/privacy`, { method: "POST", headers, body: "logging=off" });
  await fetch(`${base}/context?${reference}&chunk=${first.id}`, { headers });
  assert.equal((await fetch(`${base}/privacy/export`, { headers }).then((r) => r.json())).events.length, 0);
  const compare = await fetch(`${base}/find`, { method: "POST", headers: { ...headers, accept: "application/json" }, body: "q=bird&book=1&compare=2" }).then((r) => r.json());
  assert(compare.html.includes(text)); assert(compare.html.includes(otherText));
  const browse = await fetch(`${base}/book?${reference}&chunk=${first.id}`, { headers });
  assert.equal(browse.status, 200); assert.match(await browse.text(), /Pages and passages/);
  const updated = open(join(directory, "users/reader.db"));
  const oldSource = sourceBook(updated, String(first.book_id), first.revision!);
  await addBook(updated, { title: "Shared Title", author: "Writer", source: "first.pdf", paginated: true, page_offset: 100,
    chunks: [{ chunk_id: 0, text: "The new edition describes a different bird.", page_start: 101, page_end: 101 }] }, undefined, bytes);
  assert.throws(() => sourceContext(updated, oldSource, String(first.id)), SourceChanged);
  assert.equal(bookPdf(updated, first.book_id!, first.revision), undefined);
  updated.close();
  for (const route of ["context", "pdf-meta", "source.pdf", "reader", "pdf-page"]) {
    assert.equal((await fetch(`${base}/${route}?${reference}&chunk=${first.id}&page=101`, { headers })).status, 410, "an old source revision cannot open replacement content");
  }
  const pipelineCases = join(directory, "pipeline-cases.json"), unsupportedCases = join(directory, "unsupported.json"), pipelineReport = join(directory, "pipeline-report.json");
  writeFileSync(pipelineCases, JSON.stringify([{ query: "Where does the bird return?", expect: text }, { query: "Missing corpus?", expect: "This passage is absent from the fixture." }]));
  writeFileSync(unsupportedCases, JSON.stringify([{ query: "What is tomorrow's weather?", reason: "No forecasts in the fixture." }]));
  replies.push("bird", "NONE", "weather", "NONE");
  await promisify(execFile)(process.execPath, ["eval/pipeline.ts", "--cases", pipelineCases, "--unsupported", unsupportedCases, "--output", pipelineReport, "--run", "--input-price", "0", "--output-price", "0", "--budget", "0"], { env: { ...process.env, GURU_NO_DOTENV: "1", GURU_DB: starter, GURU_PROVIDER: "openai", OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, OPENAI_API_KEY: "stub" } });
  const evaluated = JSON.parse(readFileSync(pipelineReport, "utf8"));
  assert.equal(evaluated.selected, 3); assert.equal(evaluated.eligible, 2); assert.equal(evaluated.excluded.length, 1);
  assert.equal(evaluated.scores.supported.denominator, 1); assert.equal(evaluated.scores.supported.quotedExpected, 0);
  assert.equal(evaluated.scores.supported.falseDeclines, 1, "a rerank miss remains a full Ask failure");
  assert.equal(evaluated.scores.unsupported.denominator, 1); assert.equal(evaluated.scores.unsupported.declined, 1);
  const crossSite = await fetch(`${base}/delete`, { method: "POST", headers: { ...headers, "sec-fetch-site": "cross-site" }, body: "confirm=DELETE" });
  assert.equal(crossSite.status, 403);
  const login = await fetch(`${base}/login?u=reader&p=very-long-test-password`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const cookie = login.headers.get("set-cookie")!;
  assert.match(cookie, /^__Host-guru=reader\./);
  assert(!cookie.includes("very-long-test-password"));
  const authenticated = await fetch(base, { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(authenticated.status, 200);
  assert.equal((await fetch(`${base}/delete`, { method: "POST", headers, body: "confirm=DELETE" })).status, 200);
  const logs = new Database(logFile, { readonly: true });
  assert.equal((logs.prepare("select count(*) n from log where user = 'reader'").get() as { n: number }).n, 0);
  logs.close();
} finally {
  if (child && child.exitCode === null) { child.kill(); await new Promise((r) => child!.once("exit", r)); }
  if (model) await new Promise<void>((resolve) => model!.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
}
console.error("source and HTTP tests ok");
