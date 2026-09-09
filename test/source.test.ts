import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { addBook, bookPdf, open, search } from "../src/store.ts";
import { PYTHON, SIDECAR } from "../src/profile.ts";

const directory = mkdtempSync(join(tmpdir(), "guru-source-"));
let child: ReturnType<typeof spawn> | undefined;
try {
  const pdf = execFileSync(PYTHON, [SIDECAR, "--sample", join(directory, "Writer - Sample.pdf")], { encoding: "utf8" }).trim();
  const bytes = readFileSync(pdf);
  const starter = join(directory, "starter.db");
  const db = open(starter);
  const text = "The bright red bird returns to the forest every spring.";
  for (const source of ["first.pdf", "second.pdf"]) {
    await addBook(db, { title: "Shared Title", author: "Writer", source, paginated: true, page_offset: 100,
      chunks: [{ chunk_id: 0, text, page_start: 101, page_end: 101 }] }, undefined, bytes);
  }
  const hits = await search(db, "bright red bird");
  assert.equal(new Set(hits.map((h) => h.book_id)).size, 2);
  assert.equal(bookPdf(db, "Shared Title"), undefined, "ambiguous titles cannot choose a PDF");
  const first = hits[0];
  assert.equal(bookPdf(db, first.book_id!)?.page_offset, 100);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();

  const port = 8953;
  const base = `http://127.0.0.1:${port}`;
  const logFile = join(directory, "log.db");
  let errors = "";
  child = spawn(process.execPath, ["src/server.ts"], { env: { ...process.env,
    GURU_NO_DOTENV: "1", NODE_ENV: "development", PORT: String(port), GURU_STARTER: starter,
    GURU_USER_DIR: join(directory, "users"), GURU_LOG_DB: logFile, GURU_JOBS_DB: join(directory, "jobs.db"),
    GURU_PDF_CACHE: join(directory, "pdf-cache"), GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:very-long-test-password",
    GURU_LIBRARIAN: "operator", GURU_GUEST: "", GURU_DEMO: "", DEEPINFRA_BASE_URL: "http://127.0.0.1:9/v1",
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
  for (const tag of ["style", "script"]) {
    const code = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))![1];
    const hash = createHash("sha256").update(code).digest("base64");
    assert(home.headers.get("content-security-policy")?.includes(`'sha256-${hash}'`));
  }
  assert.equal((await fetch(`${base}/context?chunk=${first.id}`, { headers }).then((r) => r.json())).text, text);
  assert.equal((await fetch(`${base}/context?chunk=99999`, { headers }).then((r) => r.json())).text, "");
  assert.equal((await fetch(`${base}/pdf-meta?book=${first.book_id}`, { headers }).then((r) => r.json())).available, true);
  const page = await fetch(`${base}/pdf-page?book=${first.book_id}&page=101`, { headers });
  assert.equal(page.status, 200);
  assert.deepEqual(Buffer.from(await page.arrayBuffer()), execFileSync(PYTHON, [SIDECAR, "--render", pdf, "1"]));
  assert.equal((await fetch(`${base}/pdf-page?book=${first.book_id}&page=1`, { headers })).status, 404);
  const result = await fetch(`${base}/find`, { method: "POST", headers: { ...headers, accept: "application/json" }, body: "q=bright+red+bird" }).then((r) => r.json());
  assert.match(result.html, /class="source" data-chunk="\d+" data-book="\d+"/);
  assert.match(result.html, /<button type="button"/);
  assert.equal((await fetch(`${base}/log`, { headers })).status, 403);
  const exported = await fetch(`${base}/export`, { headers }).then((r) => r.json());
  assert(exported.events.some((e: { q: string }) => e.q === "bright red bird"));
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
  rmSync(directory, { recursive: true, force: true });
}
console.error("source and HTTP tests ok");
