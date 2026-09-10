const D = require("better-sqlite3"), fs = require("fs"), crypto = require("crypto"), path = require("path");
const root = process.env.GURU_RESTORE_ROOT || "/r";
const temporary = fs.mkdtempSync(path.join(require("os").tmpdir(), "guru-restore-"));
let bad = 0;
try {
if (!fs.readdirSync(root).some((f) => f.endsWith(".db"))) throw new Error("No databases in archive");
for (const f of fs.readdirSync(root).filter((f) => f.endsWith(".db")).sort()) {
  // Copied out of the read-only mount first: opening a database sets journal mode, which is
  // a write, and the point here is to leave the archive untouched.
  fs.copyFileSync(path.join(root, f), path.join(temporary, f));
  const db = new D(path.join(temporary, f));
  const integrity = db.pragma("integrity_check")[0].integrity_check;
  let detail = "";
  try {
    const books = db.prepare("select count(*) n from books").get().n;
    const chunks = db.prepare("select count(*) n from chunks").get().n;
    // A library that opens but whose text is gone would pass a row count, so read one.
    const sample = db.prepare("select text from chunks limit 1").get();
    detail = `${books} books, ${chunks} chunks, first chunk ${sample ? sample.text.length : 0} chars`;
    if (!books || !chunks || !sample) { detail += "  <-- EMPTY"; bad++; }
  } catch {
    detail = "no library tables (expected for the job queue)";
  }
  if (integrity !== "ok") bad++;
  console.log(`  ${f.padEnd(26)} integrity=${integrity}  ${detail}`);
  db.close();
}
if (fs.existsSync(path.join(root, "snapshot.json"))) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot.json"), "utf8"));
  if (manifest.version !== 1) throw new Error("Unknown snapshot version");
  if (!Array.isArray(manifest.databases) || !manifest.databases.length) throw new Error("Missing database inventory");
  for (const item of manifest.databases) {
    if (!/^[a-zA-Z0-9_.-]+\.db$/.test(item.archive) || !fs.existsSync(path.join(root, item.archive))) throw new Error("A recorded database is missing");
  }
  for (const item of manifest.uploads) {
    const file = path.resolve(root, item.archive);
    if (!file.startsWith(path.join(root, "uploads") + path.sep)) throw new Error("Invalid upload archive path");
    if (!fs.existsSync(file) || crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== item.sha256) throw new Error("Pending upload missing or changed");
  }
  const jobFile = manifest.databases.find((item) => item.archive === manifest.queue);
  if (manifest.queue && !jobFile) throw new Error("Recorded queue is missing from database inventory");
  if (jobFile) {
    const queue = new D(path.join(temporary, jobFile.archive));
    for (const job of queue.prepare("select id from jobs where state in ('queued','running')").all()) if (!manifest.uploads.some((item) => item.job === job.id)) throw new Error("Pending job has no source file");
    queue.close();
  }
  console.log(`Verified ${manifest.uploads.length} pending upload files.`);
} else console.log("Legacy snapshot. Pending uploads were not recorded.");
console.log(bad ? `FAIL: ${bad} database(s) did not verify` : "RESTORE OK: every database opened and read back");
if (bad) process.exitCode = 1;
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
