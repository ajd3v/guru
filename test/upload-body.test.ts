import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receive } from "../src/upload.ts";

const dir = mkdtempSync(join(tmpdir(), "guru-body-"));
const chunks = async function* () { yield Buffer.from("sample"); };
try {
  const target = join(dir, "sample.pdf");
  assert.equal(await receive(chunks(), target, 6), 6);
  assert.equal(readFileSync(target, "utf8"), "sample");
  await assert.rejects(receive(chunks(), target, 6), { code: "EEXIST" });
  assert.equal(readFileSync(target, "utf8"), "sample", "an existing file survives an open error");
  await assert.rejects(receive(chunks(), join(dir, "missing/file"), 6), { code: "ENOENT" });
  const oversized = join(dir, "oversized.pdf");
  await assert.rejects(receive(chunks(), oversized, 5), /too large/);
  assert.equal(existsSync(oversized), false);
  const partial = join(dir, "partial.pdf");
  const aborted = async function* () { yield Buffer.from("partial"); throw new Error("aborted body"); };
  await assert.rejects(receive(aborted(), partial, 100), /aborted body/);
  assert.equal(existsSync(partial), false);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("upload body tests ok");
