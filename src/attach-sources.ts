// Attach verified original files without rebuilding text or search indexes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { open } from "./store.ts";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const arg = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const planFile = arg("--plan"), database = arg("--database"), files = arg("--files");
if (!planFile || !database) throw new Error("Use --plan REPORT.json --database LIBRARY.db [--files DIRECTORY] [--apply]");
const apply = process.argv.includes("--apply");
const plan = JSON.parse(readFileSync(planFile, "utf8"));
if (plan.version !== 1 || !Array.isArray(plan.rows)) throw new Error("Unsupported verification report");
const db = apply ? open(database) : new Database(database, { readonly: true });
try {
  const verified = plan.rows.filter((row: any) => row.verified === true);
  if (!verified.length) throw new Error("No verified sources");
  const run = () => {
    let attached = 0;
    for (const row of verified) {
      const book = db.prepare("select id,title,author,source,paginated from books where source = ?").get(row.book.source);
      if (!book || JSON.stringify({ ...book, id: row.book.id }) !== JSON.stringify(row.book)) throw new Error(`Book metadata changed: ${row.book.source}`);
      const chunks = db.prepare("select chunk_id,text,page_start,page_end from chunks where book_id = ? order by chunk_id").all((book as { id: number }).id);
      if (hash(JSON.stringify(chunks)) !== row.contentHash) throw new Error(`Stored text or page mapping changed: ${row.book.source}`);
      const pdf = readFileSync(files ? join(files, basename(row.path)) : row.path);
      if (hash(pdf) !== row.sha256 || pdf.subarray(0, 5).toString() !== "%PDF-" || !Number.isSafeInteger(row.pageOffset)) throw new Error(`Original file changed: ${row.book.source}`);
      if (apply) db.prepare("update books set pdf = ?, page_offset = ?, extraction_quality = ?, revision = lower(hex(randomblob(16))) where id = ?").run(pdf, row.pageOffset, JSON.stringify(row.quality), (book as { id: number }).id);
      attached++;
    }
    return attached;
  };
  const count = apply ? db.transaction(run)() : run();
  console.log(`${apply ? "Attached" : "Validated"} ${count}/${plan.rows.length} sources. ${apply ? "Text and indexes unchanged. Source revisions replaced." : "No database writes."}`);
} finally { db.close(); }
