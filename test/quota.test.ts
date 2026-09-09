#!/usr/bin/env node
/**
 * The guest allowance, end to end.
 *
 * The unit-level half of this lives in `server.ts --selfcheck`, which proves a device cookie
 * cannot be forged. This proves the part that only shows up over HTTP: that two browsers
 * behind one address get separate allowances, and that the address still stops handing them
 * out. Those two pull in opposite directions and the whole design is where they meet, so a
 * regression in either one is silent without this.
 *
 * The model endpoint is deliberately unreachable. Every assertion here is about whether the
 * request got PAST the quota gate, which happens before any model call, so an allowed ask
 * failing at the network is the expected shape of "allowed" and costs nothing to run.
 */
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "../src/store.ts";

const PORT = 8952;
const ASKS = 2;
const DEVICES = 2;
const dir = mkdtempSync(join(tmpdir(), "guru-quota-"));
open(join(dir, "starter.db")).close();

const srv = spawn("node", ["src/server.ts"], {
  stdio: ["ignore", "ignore", "ignore"],
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: "development",
    GURU_DB: join(dir, "lib.db"),
    GURU_STARTER: join(dir, "starter.db"),
    GURU_JOBS_DB: join(dir, "jobs.db"),
    GURU_LOG_DB: join(dir, "log.db"),
    GURU_USER_DIR: join(dir, "users"),
    GURU_SINGLE_USER: "reader",
    GURU_BASIC_AUTH: "reader:pw",
    GURU_GUEST: "guest",
    GURU_GUEST_ASKS: String(ASKS),
    GURU_GUEST_DEVICES: String(DEVICES),
    // Port 9 is "discard" and undici refuses it outright, so an allowed ask fails instantly
    // instead of waiting on a timeout.
    DEEPINFRA_API_KEY: "unused",
    DEEPINFRA_BASE_URL: "http://127.0.0.1:9/v1",
  },
});

const base = `http://127.0.0.1:${PORT}`;
const cleanup = () => {
  srv.kill();
  rmSync(dir, { recursive: true, force: true });
};

try {
  for (let i = 0; ; i++) {
    try {
      await fetch(base + "/");
      break;
    } catch {
      if (i > 80) throw new Error("server did not start");
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** A browser that has never been here: takes whatever `gd` cookie it is handed. */
  const browser = async () => {
    const response = await fetch(base + "/");
    assert.equal(response.status, 200, "isolated starter serves the guest page");
    const c = response.headers.get("set-cookie");
    assert.ok(c?.startsWith("gd="), "a first visit is issued a device cookie");
    assert.match(c!, /HttpOnly/, "the id is not readable from script");
    return c!.split(";")[0];
  };

  /** `xff` is what the client claims; the last entry is what our own proxy appended. */
  const ask = async (cookie: string, seenBy: string) =>
    (
      await fetch(base + "/ask", {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
          "x-forwarded-for": `1.2.3.4, ${seenBy}`,
        },
        body: "q=" + encodeURIComponent("what is stillness?"),
      })
    ).status;
  const spent = (s: number) => s === 429;

  const a = await browser();
  const b = await browser();
  assert.notEqual(a, b, "each browser gets its own id");

  const HERE = "9.9.9.9";
  for (let i = 0; i < ASKS; i++) assert.ok(!spent(await ask(a, HERE)), `A ask ${i + 1} is allowed`);
  assert.ok(spent(await ask(a, HERE)), "A is out after its own allowance");

  // The whole point: B shares an address with a browser that is already out, and is not
  // punished for it. This is what per-address counting got wrong.
  for (let i = 0; i < ASKS; i++) assert.ok(!spent(await ask(b, HERE)), `B ask ${i + 1} is its own`);
  assert.ok(spent(await ask(b, HERE)), "B is out after its own allowance");

  // And the other direction: clearing the cookie asks for a new id, and the server will give
  // one, so the address has to be what stops the loop.
  const c = await browser();
  assert.ok(spent(await ask(c, HERE)), "the address ceiling refuses a fresh browser");

  const forged = "gd=" + "0".repeat(32) + "." + "f".repeat(32);
  assert.ok(spent(await ask(forged, HERE)), "a forged cookie opens no bucket");

  // A different network is untouched by this one's spending.
  assert.ok(!spent(await ask(await browser(), "8.8.8.8")), "another address still has its own");

  console.log("guest quota tests ok");
} finally {
  cleanup();
}
