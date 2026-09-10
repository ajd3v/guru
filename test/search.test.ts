import { adjacentContext, fuseQueries } from "../src/retrieval.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BookSelectionError, listBooks, open, search, selectedBook } from "../src/store.ts";
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
  assert.deepEqual(await search(db, query, 5, { bookIds: [] }), [], "an empty scope never falls back to all books");
  assert.deepEqual(await search(db, query, 5, { bookIds: [9999] }), [], "a missing source never falls back to all books");
  await assert.rejects(search(db, query, 5, { bookIds: [NaN] }), /book selection/);
  await assert.rejects(search(db, query, 5, { bookIds: [-1] }), /book selection/);
  assert.deepEqual((await search(db, query, 5, { bookIds: [2] })).map((h) => h.id), [2], "exact phrases outside the selected source cannot enter the results");
  assert.deepEqual(await search(db, query, 5, { bookIds: [1, 2, 2] }), await search(db, query, 5, { bookIds: [1, 2] }), "duplicate selections do not change ranking");
  assert.equal(selectedBook(db, "2")?.title, "Notebook 2");
  assert.equal(selectedBook(db, ""), undefined);
  for (const value of ["0", "-1", "1 OR 1=1", "1.2", "1e0", "9007199254740992", "9999"]) assert.throws(() => selectedBook(db, value), BookSelectionError);
  assert.equal(listBooks(db).length, 3);

  // A source match outside the global candidate window must still be found within its book.
  for (let id = 4; id <= 24; id++) {
    db.prepare("insert into chunks(id,book_id,chunk_id,text,page_start,page_end) values (?,2,?,'A silver lantern near the gate.','1','1')").run(id, id);
    db.prepare("insert into chunks_fts(rowid,text) values (?,?)").run(id, "Where is the silver lantern?");
    db.prepare("insert into chunks_vec(rowid,embedding) values (?,?)").run(BigInt(id), Buffer.from(vector.buffer));
  }
  assert((await search(db, "Where is the silver lantern?", 1)).every((h) => h.book_id !== 1));
  assert.deepEqual((await search(db, "Where is the silver lantern?", 1, { bookIds: [1] })).map((h) => h.id), [1], "scope is applied before the candidate limit");
  db.prepare("update books set revision = lower(hex(randomblob(16)))").run();
  const ranked = await search(db, query, 1, { bookIds: [2] });
  const neighbors = adjacentContext(db, ranked);
  assert(neighbors.length > ranked.length);
  assert(neighbors.every((h) => h.book_id === 2 && h.revision === ranked[0].revision));
  assert.equal(new Set(neighbors.map((h) => h.id)).size, neighbors.length);
  assert.equal(fuseQueries([neighbors, neighbors], 2).length, 2);
  assert.equal(fuseQueries([neighbors, neighbors], 2)[0].id, neighbors[0].id);
  db.prepare("update books set revision = lower(hex(randomblob(16))) where id=2").run();
  assert.equal(adjacentContext(db, ranked).length, ranked.length, "stale hits cannot pull context from replacement books");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  const output = execFileSync(process.execPath, ["src/cli.ts", "find", query], {
    encoding: "utf8", env: { ...process.env, GURU_NO_DOTENV: "1", GURU_DB: file, GURU_PROVIDER: "disabled-for-offline-check" },
  });
  assert(output.includes("silver lantern"), "CLI Find works with no usable model provider");
  const scoped = execFileSync(process.execPath, ["src/cli.ts", "find", query, "--book", "1"], {
    encoding: "utf8", env: { ...process.env, GURU_NO_DOTENV: "1", GURU_DB: file, GURU_PROVIDER: "disabled-for-offline-check" },
  });
  assert(scoped.includes("Notebook 1"));
  assert(!scoped.includes("Notebook 2"), "CLI keeps the selected scope");
} finally { rmSync(directory, { recursive: true, force: true }); }
console.error("retrieval and excerpt tests ok");
