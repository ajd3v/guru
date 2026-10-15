import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

const dir = mkdtempSync(join(tmpdir(), "guru-sign-in-"));
Object.assign(process.env, {
  GURU_NO_DOTENV: "1", NODE_ENV: "test", GURU_PROFILE: join(process.cwd(), "guru.config.json"),
  GURU_SINGLE_USER: "reader", GURU_BASIC_AUTH: "reader:synthetic-password,other:another-synthetic-password",
  GURU_GUEST: "guest", GURU_TRUST_PROXY: "1", GURU_CANONICAL_HOST: "",
  GURU_USER_DIR: join(dir, "users"), GURU_STARTER: join(dir, "starter.db"),
  GURU_JOBS_DB: join(dir, "jobs.db"), GURU_LOG_DB: join(dir, "log.db"),
});
delete process.env.CLERK_SECRET_KEY;

// Exercise the actual HTTP callback in memory without opening a listening socket.
const original = http.createServer;
let handle: (req: any, res: any) => void;
http.createServer = ((listener: typeof handle) => {
  handle = listener;
  return { listen() { return this; } };
}) as typeof http.createServer;
syncBuiltinESMExports();
try {
  const { open } = await import("../src/store.ts");
  const starter = open(process.env.GURU_STARTER);
  starter.prepare("insert into books (title, author, source, paginated) values ('Notebook', 'Writer', 'sample.txt', 0)").run();
  starter.pragma("wal_checkpoint(TRUNCATE)");
  starter.close();
  await import("../src/server.ts");
} finally {
  http.createServer = original;
  syncBuiltinESMExports();
}

type Response = { status: number; headers: Record<string, string> };
const request = (url = "/", headers: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
  const req = Object.assign(Readable.from([]), {
    url, method: "GET", headers: { host: "reader.example", ...headers }, socket: { remoteAddress: "127.0.0.1" },
  });
  const responseHeaders: Record<string, string> = {};
  const res = {
    statusCode: 200, headersSent: false,
    setHeader(name: string, value: string) { responseHeaders[name.toLowerCase()] = value; return this; },
    writeHead(status: number, values: Record<string, string> = {}) {
      this.statusCode = status; this.headersSent = true;
      for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
      return this;
    },
    end() { resolve({ status: this.statusCode, headers: responseHeaders }); return this; },
    destroy() { reject(new Error("response destroyed")); },
  };
  handle(req, res);
});
const basic = (credential: string) => `Basic ${Buffer.from(credential).toString("base64")}`;
const valid = { authorization: basic("reader:synthetic-password") };
const invalid = { authorization: basic("reader:wrong-password") };
const from = (address: string) => ({ "x-forwarded-for": address });
try {
  const login = await request("/login", valid);
  assert.equal(login.status, 302);
  const cookie = login.headers["set-cookie"].split(";")[0];
  const { linkToken } = await import("../src/auth.ts");
  const link = `/login?u=reader&t=${linkToken("reader")}`;
  for (let i = 0; i < 10; i++) {
    assert.equal((await request("/login?u=reader&t=x", from("198.51.100.1"))).status, 401);
  }
  assert.equal((await request("/login?u=reader&t=x", from("198.51.100.1"))).status, 429);
  const compare = crypto.timingSafeEqual;
  let comparisons = 0;
  crypto.timingSafeEqual = ((a, b) => { comparisons++; return compare(a, b); }) as typeof compare;
  syncBuiltinESMExports();
  try {
    assert.equal((await request(link, from("198.51.100.1"))).status, 429, "a correct link is indistinguishable from a wrong link while locked");
    for (const authorization of [valid, invalid]) {
      assert.equal((await request("/", { ...authorization, ...from("198.51.100.1") })).status, 429);
      assert.equal((await request("/login", { ...authorization, ...from("198.51.100.1") })).status, 429);
    }
    assert.equal(comparisons, 0, "locked requests never compare passwords or token signatures");
    assert.equal((await request("/login", { ...valid, ...from("203.0.113.7") })).status, 302);
    assert.ok(comparisons > 0, "the comparison spy observes an unlocked password check");
    comparisons = 0;
    assert.equal((await request(link, from("203.0.113.7"))).status, 302);
    assert.ok(comparisons > 0, "the comparison spy observes an unlocked link check");
  } finally {
    crypto.timingSafeEqual = compare;
    syncBuiltinESMExports();
  }
  assert.equal((await request("/", { cookie, ...from("198.51.100.1") })).status, 200);
  assert.equal((await request("/login", valid)).status, 302);
  assert.equal((await request(link, from("203.0.113.1"))).status, 302, "a different address can still sign in to the named account");
  assert.equal((await request("/", { ...valid, ...from("203.0.113.1") })).status, 200);
  assert.equal((await request("/", { ...invalid, ...from("203.0.113.2") })).status, 401);
  for (let i = 0; i < 10; i++) {
    assert.equal((await request("/", { authorization: basic("unknown:wrong"), ...from("203.0.113.3") })).status, 401);
  }
  assert.equal((await request("/", { authorization: basic("unknown:wrong"), ...from("203.0.113.3") })).status, 429);
  assert.equal((await request("/", from("203.0.113.3"))).status, 200, "guests and healthchecks survive address lockout");
  assert.equal((await request("/", { ...valid, ...from("203.0.113.3") })).status, 429);
  assert.equal((await request("/login", { ...valid, ...from("203.0.113.3") })).status, 429);
  assert.equal((await request(link, from("203.0.113.3"))).status, 429);
  assert.equal((await request("/", { cookie, ...from("203.0.113.3") })).status, 200);
  for (let i = 0; i < 10; i++) {
    assert.equal((await request("/login?u=reader&t=x", from(`198.51.100.${i + 10}`))).status, 401);
  }
  assert.equal((await request("/login", { ...valid, ...from("203.0.113.5") })).status, 302, "guesses from other addresses cannot globally lock the account");
  for (let i = 0; i < 12; i++) {
    assert.equal((await request("/", { cookie: "__Host-guru=other.stale", ...from("203.0.113.4") })).status, 401);
    assert.equal((await request("/login?u=other", from("203.0.113.4"))).status, 401);
  }
  assert.equal((await request("/", { authorization: basic("other:wrong"), ...from("203.0.113.4") })).status, 401, "stale cookies and bare logins do not fill counters");
  assert.equal((await request("/", { cookie, ...invalid, ...from("203.0.113.3") })).status, 429, "an explicit Basic attempt cannot use a cookie to bypass lockout");
  assert.equal((await request("/", { cookie, ...invalid, ...from("203.0.113.6") })).status, 401, "invalid Basic credentials still take precedence over cookies");
  assert.equal((await request("/login?u=reader&t=x", valid)).status, 401, "explicit link checks retain their precedence");
  console.log("sign-in lockout regressions ok");
} finally { rmSync(dir, { recursive: true, force: true }); }
