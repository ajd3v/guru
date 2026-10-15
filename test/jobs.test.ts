import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openJobs, enqueue, claim, requeueStale, finish, listJobs } from "../src/jobs.ts";

const dir = mkdtempSync(join(tmpdir(), "guru-jobs-"));
try {
  const path = join(dir, "jobs.db");
  const old = new Database(path);
  old.exec("create table jobs (id integer primary key, user_id text, path text, filename text, state text default 'queued', error text, created_at text)");
  old.close();
  const db = openJobs(path);
  const file = join(dir, "poison.pdf");
  writeFileSync(file, "synthetic");
  const id = enqueue(db, "reader", file, "poison.pdf");
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(claim(db)?.attempts, attempt);
    assert.equal(claim(db), undefined);
    assert.equal(requeueStale(db), 1);
  }
  assert.equal(claim(db), undefined);
  assert.equal(listJobs(db, "reader")[0].state, "failed");
  assert.equal(existsSync(file), false);
  const next = enqueue(db, "reader", join(dir, "normal.pdf"), "normal.pdf");
  assert.equal(claim(db)?.id, next);
  finish(db, next);
  assert.equal(listJobs(db, "reader")[0].state, "done");
  assert.notEqual(next, id);
  db.close();
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("jobs tests ok");
