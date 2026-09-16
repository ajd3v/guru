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

  readerDb.close();
  console.error("starter reconciliation tests ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
