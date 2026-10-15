import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJobs, reserveUpload, completeUpload, discardReceiving, claim, finish, countActive } from "../src/jobs.ts";

const dir = mkdtempSync(join(tmpdir(), "guru-upload-"));
const db = openJobs(join(dir, "jobs.db"));
try {
  const reserve = (user = "reader", held = 1, books = 2) => reserveUpload(db, user, join(dir, user + ".pdf"), "sample.pdf", () => held, books, 100, 200);
  const first = reserve()!;
  assert.ok(first);
  assert.equal(claim(db), undefined, "partial uploads cannot be ingested");
  for (let i = 0; i < 8; i++) assert.equal(reserve(), undefined, "one free slot has one reservation");
  assert.equal(countActive(db, "reader"), 1);
  assert.equal(completeUpload(db, first, 50, join(dir, "reader.pdf")), true);
  assert.equal(completeUpload(db, first, 50, join(dir, "reader.pdf")), false);
  assert.equal(claim(db)?.id, first);
  finish(db, first);
  assert.equal(reserve("reader", 2), undefined, "held books retain the cap after completion");
  const a = reserve("bytes", 0, Infinity)!;
  const b = reserve("bytes", 0, Infinity)!;
  assert.equal(reserve("bytes", 0, Infinity), undefined, "byte cap also applies without a book cap");
  assert.equal(completeUpload(db, a, 10, join(dir, "bytes.pdf")), true);
  assert.equal(reserve("bytes", 0, Infinity), undefined, "actual bytes plus reservation must fit");
  db.prepare("delete from jobs where id = ?").run(b);
  assert.ok(reserve("bytes", 0, Infinity));
  writeFileSync(join(dir, "bytes.pdf"), "partial");
  discardReceiving(db);
  assert.equal(existsSync(join(dir, "bytes.pdf")), false);
  assert.equal(completeUpload(db, b, 10, join(dir, "bytes.pdf")), false, "cancelled uploads stay cancelled");
  const old = reserveUpload(db, "cancel", join(dir, "old.pdf"), "old.pdf", () => 0, 10, 100, 200)!;
  db.prepare("delete from jobs where id = ?").run(old);
  const replacement = reserveUpload(db, "cancel", join(dir, "new.pdf"), "new.pdf", () => 0, 10, 100, 200)!;
  assert.equal(replacement, old, "SQLite may reuse a deleted job id");
  assert.equal(completeUpload(db, old, 10, join(dir, "old.pdf")), false);
  assert.equal(completeUpload(db, replacement, 10, join(dir, "new.pdf")), true);
} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
console.log("upload reservations ok");
