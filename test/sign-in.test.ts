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

type Response = { status: number; headers: Record<string, string>; body: string };
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
    end(body = "") { resolve({ status: this.statusCode, headers: responseHeaders, body }); return this; },
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
  for (let i = 0; i < 12; i++) {
    assert.equal((await request("/", { cookie: "__Host-guru=other.stale", ...from("203.0.113.4") })).status, 401);
    assert.equal((await request("/login?u=other", from("203.0.113.4"))).status, 401);
  }
  assert.equal((await request("/", { authorization: basic("other:wrong"), ...from("203.0.113.4") })).status, 401, "stale cookies and bare logins do not fill counters");
  assert.equal((await request("/", { cookie, ...invalid, ...from("203.0.113.3") })).status, 429, "an explicit Basic attempt cannot use a cookie to bypass lockout");
  assert.equal((await request("/", { cookie, ...invalid, ...from("203.0.113.6") })).status, 401, "invalid Basic credentials still take precedence over cookies");
  assert.equal((await request("/login?u=reader&t=x", valid)).status, 401, "explicit link checks retain their precedence");
  for (let i = 0; i < 25; i++) {
    assert.equal((await request("/", { authorization: basic("unknown:wrong"), ...from(`192.0.2.${i + 1}`) })).status, 401, "an unknown name never gets an account counter");
    assert.equal((await request("/login?u=unknown&t=x", from(`192.0.2.${i + 30}`))).status, 401, "unknown link names never get an account counter");
    assert.equal((await request("/login?u=reader&t=x", { ...invalid, ...from(`192.0.2.${i + 60}`) })).status, 401, "explicit token attempts use only the address counter even with a Basic header");
  }
  assert.equal((await request("/login?u=reader&t=", { ...valid, ...from("192.0.2.90") })).status, 401, "an empty token still takes precedence over Basic credentials");
  assert.equal((await request("/login", { ...valid, ...from("203.0.113.5") })).status, 302);
  assert.equal((await request("/", { ...valid, ...from("203.0.113.8") })).status, 200);
  assert.equal((await request(link, from("203.0.113.9"))).status, 302);
  const deviceCookie = (await request("/login", { authorization: basic("unknown:wrong"), ...from("192.0.2.200") })).headers["set-cookie"].split(";")[0];
  const rejected = new Map<string, Response>();
  for (const path of ["/", "/login"]) {
    const unknown = await request(path, { cookie: deviceCookie, authorization: basic("unknown:wrong"), ...from("192.0.2.201") });
    assert.equal(unknown.status, 401);
    assert.deepEqual(await request(path, { cookie: deviceCookie, ...invalid, ...from("192.0.2.202") }), unknown, "ordinary wrong passwords have the same response for known and unknown readers");
    rejected.set(path, unknown);
  }
  const statuses: number[] = [];
  for (let i = 0; i < 25; i++) {
    statuses.push((await request(i % 2 ? "/login" : "/", { ...invalid, ...from(`198.51.100.${i + 10}`) })).status);
  }
  assert.deepEqual(statuses, Array(25).fill(401), "rotating password guesses keep the wrong-password response when account throttling starts");
  assert.equal((await request("/login", { ...valid, ...from("203.0.113.5") })).status, 302, "password login establishes trust during an account attack");
  assert.equal((await request("/", { ...valid, ...from("203.0.113.8") })).status, 200, "Basic authentication establishes trust during an account attack");
  assert.equal((await request(link, from("203.0.113.9"))).status, 302, "link login establishes trust during an account attack");
  assert.equal((await request("/", { cookie, ...from("203.0.113.10") })).status, 200, "existing sessions survive an account attack");
  for (const authorization of [valid, invalid]) {
    for (const path of ["/", "/login"]) {
      assert.deepEqual(await request(path, { cookie: deviceCookie, ...authorization, ...from("203.0.113.10") }), rejected.get(path), "account throttling returns the ordinary wrong-password response for correct and incorrect passwords");
    }
  }
  comparisons = 0;
  crypto.timingSafeEqual = ((a, b) => { comparisons++; return compare(a, b); }) as typeof compare;
  syncBuiltinESMExports();
  try {
    for (const authorization of [valid, invalid]) {
      for (const path of ["/", "/login"]) {
        assert.equal((await request(path, { ...authorization, ...from("203.0.113.10") })).status, 401);
      }
    }
    assert.equal(comparisons, 0, "rotating password guesses are throttled before any credential comparison");
    assert.equal((await request(link, from("203.0.113.10"))).status, 302, "guesses from other addresses cannot lock a reader out of link sign-in on a fresh address");
    assert.ok(comparisons > 0, "a link still verifies its signature while password guesses are throttled");
    assert.equal((await request("/", { ...valid, ...from("203.0.113.10") })).status, 200, "successful link sign-in trusts the new address for password sign-ins");
    assert.equal((await request(link, { ...invalid, ...from("203.0.113.11") })).status, 302, "an explicit link bypasses password throttling even with a Basic header");
    assert.equal((await request("/login?u=reader&t=x", from("203.0.113.12"))).status, 401);
    assert.equal((await request("/login?u=reader&t=", { ...valid, ...from("203.0.113.12") })).status, 401);
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(await request("/", { cookie: deviceCookie, ...valid, ...from("203.0.113.13") }), rejected.get("/"));
    }
    comparisons = 0;
    for (const path of ["/", "/login", link, "/login?u=reader&t=x"]) {
      assert.equal((await request(path, { ...valid, ...from("203.0.113.13") })).status, 429, "account-throttled failures still exhaust the address counter");
    }
    assert.equal(comparisons, 0, "the address limit still rejects both auth paths before credential verification");
    assert.equal((await request("/", { ...valid, ...from("203.0.113.8") })).status, 200);
    assert.ok(comparisons > 0, "trusted addresses still verify credentials");
  } finally {
    crypto.timingSafeEqual = compare;
    syncBuiltinESMExports();
  }
  console.log("sign-in lockout regressions ok");
} finally { rmSync(dir, { recursive: true, force: true }); }
