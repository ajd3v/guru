import assert from "node:assert/strict";
import { renderPage, requestLimit } from "../src/render.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PYTHON, SIDECAR } from "../src/profile.ts";

const allow = requestLimit(2, 100);
assert.equal(allow("guest", 0), true);
assert.equal(allow("guest", 1), true);
assert.equal(allow("guest", 2), false);
assert.equal(allow("other", 2), true);
assert.equal(allow("guest", 100), true);
const dir = mkdtempSync(join(tmpdir(), "guru-render-"));
try {
  const pdf = join(dir, "sample.pdf");
  await promisify(execFile)(PYTHON, [SIDECAR, "--sample", pdf]);
  const pending = [renderPage(pdf, 1), renderPage(pdf, 2)];
  assert.equal(await renderPage(pdf, 3), undefined, "render concurrency is bounded");
  for (const png of await Promise.all(pending)) {
    assert.equal(png?.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  }
  await assert.rejects(renderPage(pdf, 999));
  assert.ok(await renderPage(pdf, 1), "a failed render releases its slot");
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("render limits ok");
