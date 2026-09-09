import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, search } from "../src/store.ts";
import { embed } from "../src/embed.ts";
import { excerpt } from "../src/excerpt.ts";

const opening = "This introduction discusses the arrangement of the notebook. ".repeat(20);
const answer = "The silver lantern stays beside the eastern gate throughout winter.";
const source = opening + answer + " The keeper returns each morning to inspect the glass. ".repeat(12);
const preview = excerpt(source, "Where is the silver lantern?", 500);
assert(preview.includes(answer), "a late match must be visible in the preview");
assert(preview.startsWith("... "));
assert(source.includes(preview.replace(/^\.\.\. /, "").replace(/ \.\.\.$/, "")), "preview is one unchanged source span");
assert.equal(excerpt("Be still.", "advice"), "Be still.");
assert.throws(() => excerpt(source, "lantern", 0), /budget/);

const directory = mkdtempSync(join(tmpdir(), "guru-search-"));
const file = join(directory, "library.db");
try {
  const db = open(file);
  assert.deepEqual(await search(db, " ?! "), [], "an empty query must not return arbitrary books");
  await assert.rejects(search(db, "lantern", 0), /limit/);
  await assert.rejects(search(db, "lantern", 5, { vectorWeight: NaN }), /weight/);
  const query = 'Where is the "silver lantern"?';
  const [vector] = await embed([query], "query");
  const fixtures = [
    { text: "A silver lantern stands beside the gate.", vector: new Float32Array(vector.map((v) => -v)) },
    { text: "A silver bell hangs where the lantern was kept.", vector },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    const id = index + 1;
    db.prepare("insert into books(id,title,author,source,paginated) values (?,?,?,?,1)").run(id, "Notebook " + id, "A. Writer", id + ".pdf");
    db.prepare("insert into chunks(id,book_id,chunk_id,text,page_start,page_end) values (?,?,0,?,'1','1')").run(id, id, fixture.text);
    db.prepare("insert into chunks_fts(rowid,text) values (?,?)").run(id, fixture.text);
    db.prepare("insert into chunks_vec(rowid,embedding) values (?,?)").run(BigInt(id), Buffer.from(fixture.vector.buffer));
  }
  assert.equal((await search(db, query, 5, { exactPhrases: false }))[0].id, 2, "fixture deliberately gives the paraphrase a stronger vector match");
  db.prepare("insert into books(id,title,author,source,paginated) values (3,'Notebook 3','A. Writer','3.pdf',1)").run();
  db.prepare("insert into chunks(id,book_id,chunk_id,text,page_start,page_end) values (3,3,0,'A brass bell stands beside the gate.','1','1')").run();
  db.prepare("insert into chunks_fts(rowid,text) values (3,?)").run("silver lantern");
  db.prepare("insert into chunks_vec(rowid,embedding) values (3,?)").run(Buffer.from(vector.buffer));
  assert.equal((await search(db, query, 5))[0].id, 1, "an explicit exact phrase takes precedence over the paraphrase");
  assert((await search(db, query, 5)).find((h) => h.id === 3)!.score < 1, "generated index context cannot earn literal source priority");
  assert.deepEqual(
    await search(db, query, 5, { literalQuery: "Where is the light?" }),
    await search(db, query, 5, { exactPhrases: false }),
    "quotation marks from query expansion do not receive literal priority",
  );
  assert.equal((await search(db, '"unknown expression"', 5)).length, 3, "missing exact phrases can still return related passages");
  assert.equal((await search(db, '"silver lantern" OR NEAR *', 5))[0].id, 1, "query punctuation is not executable FTS syntax");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  const output = execFileSync(process.execPath, ["src/cli.ts", "find", query], {
    encoding: "utf8", env: { ...process.env, GURU_NO_DOTENV: "1", GURU_DB: file, GURU_PROVIDER: "disabled-for-offline-check" },
  });
  assert(output.includes("silver lantern"), "CLI Find works with no usable model provider");
} finally { rmSync(directory, { recursive: true, force: true }); }
console.error("retrieval and excerpt tests ok");
