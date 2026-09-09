import "./profile.ts";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DIM, embed } from "./embed.ts";

export type Chunk = {
  chunk_id: number;
  text: string;
  page_start: string | number;
  page_end: string | number;
};

export type Book = {
  title: string;
  author: string;
  source: string;
  paginated: boolean;
  page_offset?: number;
  chunks: Chunk[];
};

export type Hit = Chunk & {
  id: number;
  book_id?: number;
  title: string;
  author: string;
  paginated: number;
  score: number;
};

/** One SQLite file per user: isolation by filesystem, not by WHERE clause. */
export function open(path: string) {
  const db = new Database(path);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.exec(`
    create table if not exists books (
      id integer primary key,
      title text, author text, source text unique, paginated integer, pdf blob, page_offset integer not null default 0
    );
    create table if not exists chunks (
      id integer primary key,
      book_id integer references books(id) on delete cascade,
      chunk_id integer, text text, page_start text, page_end text
    );
    create virtual table if not exists chunks_fts using fts5(text);
    create virtual table if not exists chunks_vec using vec0(embedding float[${DIM}]);
    create table if not exists asks (
      id integer primary key,
      at text not null default (current_timestamp)
    );
    create index if not exists asks_by_day on asks (at);
  `);
  // A library file created before the `pdf` column existed keeps its own table as-is:
  // `create table if not exists` above is a no-op on it. Add the column once, quietly.
  try {
    db.exec("alter table books add column pdf blob");
  } catch {
    // already there
  }
  if (!(db.pragma("table_info(books)") as { name: string }[]).some((c) => c.name === "page_offset")) {
    db.exec("alter table books add column page_offset integer not null default 0");
  }
  return db;
}

/**
 * Questions asked since UTC midnight.
 *
 * Usage lives in the reader's own file rather than a shared table so that everything about a
 * person is still one file, which is what makes export and delete a copy and an unlink.
 * The day boundary is UTC, so a reader's allowance resets mid-evening in the Americas.
 */
export const askedToday = (db: Database.Database) =>
  (db.prepare("select count(*) n from asks where at >= date('now')").get() as { n: number }).n;

export const recordAsk = (db: Database.Database) =>
  db.prepare("insert into asks default values").run();

/**
 * A user id becomes a filename, so it is a trust boundary. Reject anything that is not an
 * opaque token rather than sanitising it: a `..` or a slash here reads or creates somebody
 * else's library, which is the one failure the file-per-user model exists to prevent.
 * Clerk ids (`user_2abc…`) already satisfy this.
 */
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The reader's library, cloned from the starter template the first time they appear.
 *
 * Every user's starter corpus is byte-identical public-domain content, so it is copied
 * rather than re-embedded: ~3300 chunks per signup is minutes of CPU each, against a file
 * copy. The duplication costs ~27MB per user, roughly $4/month of volume at a thousand.
 *
 * ponytail: opens a fresh connection per call. SQLite opens in microseconds, so this only
 * needs a cache if profiling says the `create table if not exists` preamble shows up.
 */
export function libraryPath(userId: string, dir = process.env.GURU_USER_DIR ?? "data/users") {
  if (!USER_ID.test(userId)) throw new Error(`invalid user id: ${JSON.stringify(userId)}`);
  return join(dir, `${userId}.db`);
}

export function userLibrary(userId: string, dir = process.env.GURU_USER_DIR ?? "data/users") {
  // Read at call time, not module scope: an entry point that loads .env runs after this
  // module is evaluated, so a module-scope default silently wins over the configured path.
  // Prebuild with `GURU_DB=data/starter.db node src/cli.ts starter`.
  const starter = process.env.GURU_STARTER ?? "data/starter.db";
  const path = libraryPath(userId, dir);

  if (!existsSync(path)) {
    if (!existsSync(starter)) {
      throw new Error(`no starter library at ${starter}, build it: GURU_DB=${starter} node src/cli.ts starter`);
    }
    mkdirSync(dir, { recursive: true });
    // WAL mode parks recent writes in a `-wal` sidecar, so copying the `.db` alone hands the
    // reader a library missing every book. Fold the log back in first. Idempotent, and a
    // no-op once the template has been checkpointed.
    const src = new Database(starter);
    src.pragma("wal_checkpoint(TRUNCATE)");
    src.close();
    copyFileSync(starter, path);
  }
  return open(path);
}

/**
 * `contexts` are the LLM-situated versions of each chunk. They are indexed but never
 * stored: quotes must verify against the author's words, not the contextualizer's.
 */
export async function addBook(
  db: Database.Database,
  book: Book,
  contexts?: string[],
  pdf?: Buffer,
) {
  const indexed = book.chunks.map((c, i) => contexts?.[i] ?? c.text);
  const vectors = await embed(indexed);

  const insertBook = db.prepare(
    "insert or replace into books (title, author, source, paginated, pdf, page_offset) values (?,?,?,?,?,?)",
  );
  const insertChunk = db.prepare(
    "insert into chunks (book_id, chunk_id, text, page_start, page_end) values (?,?,?,?,?)",
  );
  const insertFts = db.prepare("insert into chunks_fts (rowid, text) values (?,?)");
  const insertVec = db.prepare("insert into chunks_vec (rowid, embedding) values (?,?)");

  const priorBook = db.prepare("select id from books where source = ?");
  const priorChunks = db.prepare("select id from chunks where book_id = ?");
  const deleteChunks = db.prepare("delete from chunks where book_id = ?");
  const deleteBook = db.prepare("delete from books where id = ?");
  const deleteFts = db.prepare("delete from chunks_fts where rowid = ?");
  const deleteVec = db.prepare("delete from chunks_vec where rowid = ?");

  db.transaction(() => {
    // Re-adding a book must replace it, not shadow it. `insert or replace` alone is not
    // enough: SQLite leaves foreign keys OFF by default, so the schema's `on delete cascade`
    // never fires and the previous edition's rows survive in the FTS and vector indexes.
    // Search's join hides them, which is worse than a visible duplicate. They keep taking
    // up slots in both ranked lists and quietly shift the fusion.
    const prior = priorBook.get(book.source) as { id: number } | undefined;
    if (prior) {
      for (const { id } of priorChunks.all(prior.id) as { id: number }[]) {
        deleteFts.run(BigInt(id));
        deleteVec.run(BigInt(id));
      }
      deleteChunks.run(prior.id);
      deleteBook.run(prior.id);
    }

    const bookId = insertBook.run(
      book.title, book.author, book.source, book.paginated ? 1 : 0, pdf ?? null, book.page_offset ?? 0,
    ).lastInsertRowid as number;
    book.chunks.forEach((c, i) => {
      const id = insertChunk.run(
        bookId, c.chunk_id, c.text, String(c.page_start), String(c.page_end),
      ).lastInsertRowid as number;
      // ponytail: BigInt, not Number. better-sqlite3 binds plain numbers as REAL and
      // vec0 rejects a non-integer rowid ("Only integers are allows for primary key values").
      insertFts.run(BigInt(id), indexed[i]);
      insertVec.run(BigInt(id), Buffer.from(vectors[i].buffer));
    });
  })();
}

/** FTS5 treats punctuation and AND/OR/NEAR as syntax. Quote every token, OR them together. */
function ftsQuery(q: string) {
  const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/**
 * How many candidates reach the reranker. Measured on 151 cases, the correct chunk is
 * within depth 20 for 41% of questions but within depth 100 for 63%, and the reranker
 * promotes nearly everything it is shown. Depth is therefore the cheapest recall there is.
 */
export const CANDIDATES = Number(process.env.GURU_CANDIDATES ?? 60);

/** Hybrid BM25 + vector, fused with reciprocal rank. */
export async function search(db: Database.Database, query: string, k = CANDIDATES): Promise<Hit[]> {
  const RRF_K = 60;
  // Fuse from deeper lists than we return. RRF ranks an item that is mediocre in both
  // halves above one that is first in a single half, so a shallow fetch loses exact hits.
  const depth = k * 3;
  const scores = new Map<number, number>();
  const fuse = (ids: number[]) =>
    ids.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));

  const match = ftsQuery(query);
  if (match) {
    fuse(
      db.prepare("select rowid as id from chunks_fts where chunks_fts match ? order by rank limit ?")
        .all(match, depth)
        .map((r: any) => r.id),
    );
  }

  const [vector] = await embed([query], "query");
  fuse(
    db.prepare("select rowid as id from chunks_vec where embedding match ? and k = ?")
      .all(Buffer.from(vector.buffer), BigInt(depth))
      .map((r: any) => r.id),
  );

  if (!scores.size) return [];
  const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  const rows = db.prepare(`
    select c.id, c.book_id, c.chunk_id, c.text, c.page_start, c.page_end, b.title, b.author, b.paginated
    from chunks c join books b on b.id = c.book_id
    where c.id in (${top.map(() => "?").join(",")})
  `).all(...top.map(([id]) => id)) as any[];

  const byId = new Map(rows.map((r) => [r.id, r]));
  return top.map(([id, score]) => ({ ...byId.get(id), score })).filter((h) => h.id);
}

/** The stored source PDF for a book, by title, or undefined if it has none (EPUB, or ingested
 * before this column existed). Bytes only: the caller materializes them to disk for rendering. */
export function bookPdf(db: Database.Database, identity: string | number): { id: number; pdf: Buffer; page_offset: number } | undefined {
  const rows = db.prepare(typeof identity === "number"
    ? "select id, pdf, page_offset from books where id = ?"
    : "select id, pdf, page_offset from books where title = ? limit 2").all(identity) as
    { id: number; pdf: Buffer | null; page_offset: number }[];
  return rows.length === 1 && rows[0].pdf ? rows[0] as { id: number; pdf: Buffer; page_offset: number } : undefined;
}

/** How guru cites: [Title, Author, p. N], or chapter/paragraph when the source has no pages. */
export function cite(h: Hit) {
  // No quote marks in a locator: a citation is embedded in prose that gets scanned for
  // quotations, and a stray mark there pairs with the next one and corrupts the scan.
  // Newlines go for the same reason, EPUB chapter titles wrap, and a locator broken across
  // two lines is half in the blockquote and half out of it once rendered.
  //
  // Square brackets go too, and this one was expensive: the whole citation is delimited by
  // brackets, so a Gutenberg footnote marker inside a chapter title ("HEROISM[309]") nested
  // one bracket pair inside another. The verifier could not strip the citation off the end
  // of the quotation, checked the quotation with its citation still attached, found no such
  // text in any book, and reported every correct quote from that chapter as fabricated.
  //
  // Dash runs go the same way. Gutenberg headings separate with a doubled em-dash, so a
  // chapter arrives as "CHAPTER XIX——THAT TO STUDY PHILOSOPHY IS TO LEARN TO DIE" and the
  // citation under a quotation reads with a typographic scar in it. A comma is what the
  // separator meant. Two or more, so a hyphenated word keeps its hyphen.
  const where = h.paginated && /^\d+$/.test(String(h.page_start)) && /^\d+$/.test(String(h.page_end))
    ? `p. ${h.page_start}${h.page_end !== h.page_start ? `-${h.page_end}` : ""}`
    : String(h.page_start)
        .replace(/["“”\[\]]/g, "")
        .replace(/\s*(?:[—–]|-{2,}){1,}\s*/g, ", ")
        .replace(/\s+/g, " ")
        .replace(/,\s*,/g, ",")
        .replace(/[\s,]+$/, "")
        .trim();
  // Author, then title, then locator: the order a reader expects and the one the daily
  // readings this is modelled on use. Title-first read like a catalogue entry.
  return `[${h.author}, ${h.title}, ${where}]`;
}
