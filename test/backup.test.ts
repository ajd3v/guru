import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
const root = mkdtempSync(join(tmpdir(), "guru-backup-"));
try {
  mkdirSync(join(root, "uploads"));
  const file = join(root, "uploads/pending.pdf"); writeFileSync(file, "isolated pending source");
  const db = new Database(join(root, "jobs.db"));
  db.exec("create table jobs (id integer, path text, state text)");
  db.prepare("insert into jobs values (1, ?, 'running')").run(file); db.close();
  const env = { ...process.env, GURU_DATA_ROOT: root, GURU_JOBS_DB: join(root, "jobs.db"), GURU_STAGE: join(root, "snapshot") };
  execFileSync(process.execPath, ["deploy/snapshot.cjs"], { env });
  const manifest = JSON.parse(readFileSync(join(root, "snapshot/snapshot.json"), "utf8"));
  assert.equal(manifest.uploads.length, 1);
  assert.equal(readFileSync(join(root, "snapshot", manifest.uploads[0].archive), "utf8"), "isolated pending source");
  const verifyEnv = { ...process.env, GURU_RESTORE_ROOT: join(root, "snapshot") };
  execFileSync(process.execPath, ["deploy/verify-snapshot.cjs"], { env: verifyEnv });
  const queueCopy = join(root, "snapshot", manifest.queue);
  rmSync(queueCopy);
  assert.notEqual(spawnSync(process.execPath, ["deploy/verify-snapshot.cjs"], { env: verifyEnv }).status, 0, "missing databases fail restore verification");
  rmSync(file);
  const failed = spawnSync(process.execPath, ["deploy/snapshot.cjs"], { env: { ...env, GURU_STAGE: join(root, "missing") } });
  assert.notEqual(failed.status, 0, "a queue missing its source must not become a successful backup");
} finally { rmSync(root, { recursive: true, force: true }); }
console.error("backup tests ok");
