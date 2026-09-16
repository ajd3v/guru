import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBook, open, reconcileStarter, search } from "../src/store.ts";

const dir = mkdtempSync(join(tmpdir(), "guru-reconcile-"));
try {
  const starterPath = join(dir, "starter.db");
  const starterDb = open(starterPath);

  await addBook(starterDb, {
    title: "Tao Teh King",
    author: "Laozi",
    source: "tao.epub",
    paginated: false,
    chunks: [{ chunk_id: 0, text: "The Tao that can be trodden is not the enduring Tao.", page_start: 1, page_end: 1 }],
  });

  await addBook(starterDb, {
    title: "Walden",
    author: "Henry David Thoreau",
    source: "walden.epub",
    paginated: true,
    chunks: [{ chunk_id: 0, text: "The mass of men lead lives of quiet desperation.", page_start: 5, page_end: 5 }],
  });

  starterDb.pragma("wal_checkpoint(TRUNCATE)");
  starterDb.close();

  // Reader database initially has only Tao Teh King, plus their private upload
  const readerPath = join(dir, "reader.db");
  const readerDb = open(readerPath);

  await addBook(readerDb, {
    title: "Tao Teh King",
    author: "Laozi",
    source: "tao.epub",
    paginated: false,
    chunks: [{ chunk_id: 0, text: "The Tao that can be trodden is not the enduring Tao.", page_start: 1, page_end: 1 }],
  });

  await addBook(readerDb, {
    title: "Field Journal",
    author: "Reader",
    source: "Reader - Field Journal.pdf",
    paginated: true,
    chunks: [{ chunk_id: 0, text: "Observed morning fog over the eastern valley ridge.", page_start: 12, page_end: 12 }],
  });

  // Reconcile: Walden should be added, Tao Teh King and Field Journal preserved
  const added = reconcileStarter(readerDb, starterPath);
  assert.equal(added, 1, "exactly one missing starter book should be added");

  const books = readerDb.prepare("select title, author from books order by id").all() as { title: string; author: string }[];
  assert.equal(books.length, 3);
  assert.deepEqual(books.map((b) => b.title), ["Tao Teh King", "Field Journal", "Walden"]);

  // Walden must be searchable in reader's db via both vector and keyword search
  const hits = await search(readerDb, "quiet desperation");
  assert(hits.some((h) => h.title === "Walden"), "reconciled book must be searchable");

  // Reader's own upload must still be searchable
  const uploadHits = await search(readerDb, "eastern valley ridge");
  assert(uploadHits.some((h) => h.title === "Field Journal"), "reader upload must remain searchable");

  // Idempotency: second call should add nothing
  const secondPass = reconcileStarter(readerDb, starterPath);
  assert.equal(secondPass, 0, "subsequent reconciliation should add zero books");

  // Legacy starter schema without modern columns (pdf, page_offset, revision, extraction_quality)
  const legacyStarterPath = join(dir, "legacy_starter.db");
  const legacyStarter = new (await import("better-sqlite3")).default(legacyStarterPath);
  (await import("sqlite-vec")).load(legacyStarter);
  legacyStarter.exec(`
    create table books (id integer primary key, title text, author text, source text unique, paginated integer);
    create table chunks (id integer primary key, book_id integer, chunk_id integer, text text, page_start text, page_end text);
    create virtual table chunks_fts using fts5(text);
    create virtual table chunks_vec using vec0(embedding float[768]);
    insert into books (id, title, author, source, paginated) values (1, 'Legacy Wisdom', 'Ancient Sage', 'legacy.epub', 0);
  `);
  legacyStarter.prepare("insert into chunks (id, book_id, chunk_id, text, page_start, page_end) values (1, 1, 0, 'Ancient timeless sentence.', '1', '1')").run();
  legacyStarter.prepare("insert into chunks_fts (rowid, text) values (1, 'Ancient timeless sentence.')").run();
  const dummyVec = new Float32Array(768);
  legacyStarter.prepare("insert into chunks_vec (rowid, embedding) values (1, ?)").run(Buffer.from(dummyVec.buffer));
  legacyStarter.close();

  const legacyAdded = reconcileStarter(readerDb, legacyStarterPath);
  assert.equal(legacyAdded, 1, "legacy starter book should be reconciled smoothly");
  const legacyBook = readerDb.prepare("select * from books where title = 'Legacy Wisdom'").get() as { title: string; revision: string; page_offset: number };
  assert.equal(legacyBook.title, "Legacy Wisdom");
  assert.equal(legacyBook.page_offset, 0);
  assert(legacyBook.revision, "revision should be assigned");

  readerDb.close();
  console.error("starter reconciliation tests ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
