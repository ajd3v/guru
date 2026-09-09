import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { ENGINE_ROOT, profile } from "./profile.ts";
import { starterFingerprint } from "./starter.ts";

const starter = process.env.GURU_STARTER ?? "data/starter.db";
const stamp = `${starter}.manifest`;
const mode = process.env.GURU_STARTER_MODE ?? profile.starterMode;
if (!["automatic", "managed"].includes(mode)) throw new Error("Invalid GURU_STARTER_MODE");
const children = new Set<ChildProcess>();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  stopping = true;
  for (const child of children) child.kill(signal);
});
function run(file: string, args: string[] = [], env = process.env) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [join(ENGINE_ROOT, file), ...args], { env, stdio: "inherit" });
    children.add(child);
    child.on("error", reject);
    child.on("exit", (code) => { children.delete(child); resolve(code ?? 1); });
  });
}
function validStarter() {
  if (!existsSync(starter)) return false;
  try {
    const db = new Database(starter, { readonly: true });
    try { return (db.prepare("select count(*) n from books").get() as { n: number }).n > 0; }
    finally { db.close(); }
  } catch { return false; }
}
async function build(hash: string) {
  const temporary = `${starter}.building.${process.pid}`;
  mkdirSync(dirname(starter), { recursive: true });
  try {
    const code = await run("src/cli.ts", ["starter"], { ...process.env, GURU_DB: temporary });
    if (code || stopping) throw new Error("Starter build failed");
    const db = new Database(temporary);
    const count = (db.prepare("select count(*) n from books").get() as { n: number }).n;
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    if (!count) throw new Error("Starter build produced no books");
    renameSync(temporary, starter);
    writeFileSync(stamp, hash);
    console.error(`Starter ready. ${count} books. Existing reader libraries were preserved.`);
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(temporary + suffix, { force: true });
  }
}

const role = process.argv[2] ?? "serve";
if (!["serve", "worker"].includes(role)) throw new Error("Role must be serve or worker");
if (mode === "managed") {
  if (!validStarter()) throw new Error("Managed starter is missing or empty. Supply it before starting.");
} else {
  const hash = starterFingerprint();
  const current = () => existsSync(stamp) && readFileSync(stamp, "utf8").trim() === hash && validStarter();
  if (role === "serve" && !current()) {
    if (validStarter()) void build(hash).catch((error) => console.error("Starter update failed:", error.message));
    else await build(hash);
  } else if (role === "worker") {
    while (!current() && !stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
if (!stopping) process.exitCode = await run(role === "serve" ? "src/server.ts" : "src/cli.ts", role === "worker" ? ["worker"] : []);
