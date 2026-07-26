import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
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
  chunks: Chunk[];
};

export type Hit = Chunk & {
  id: number;
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
      title text, author text, source text unique, paginated integer
    );
    create table if not exists chunks (
      id integer primary key,
      book_id integer references books(id) on delete cascade,
      chunk_id integer, text text, page_start text, page_end text
    );
    create virtual table if not exists chunks_fts using fts5(text);
    create virtual table if not exists chunks_vec using vec0(embedding float[${DIM}]);
  `);
  return db;
}

/**
 * `contexts` are the LLM-situated versions of each chunk. They are indexed but never
 * stored: quotes must verify against the author's words, not the contextualizer's.
 */
export async function addBook(db: Database.Database, book: Book, contexts?: string[]) {
  const indexed = book.chunks.map((c, i) => contexts?.[i] ?? c.text);
  const vectors = await embed(indexed);

  const insertBook = db.prepare(
    "insert or replace into books (title, author, source, paginated) values (?,?,?,?)",
  );
  const insertChunk = db.prepare(
    "insert into chunks (book_id, chunk_id, text, page_start, page_end) values (?,?,?,?,?)",
  );
  const insertFts = db.prepare("insert into chunks_fts (rowid, text) values (?,?)");
  const insertVec = db.prepare("insert into chunks_vec (rowid, embedding) values (?,?)");

  db.transaction(() => {
    const bookId = insertBook.run(book.title, book.author, book.source, book.paginated ? 1 : 0)
      .lastInsertRowid as number;
    book.chunks.forEach((c, i) => {
      const id = insertChunk.run(
        bookId, c.chunk_id, c.text, String(c.page_start), String(c.page_end),
      ).lastInsertRowid as number;
      // ponytail: BigInt, not Number — better-sqlite3 binds plain numbers as REAL and
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
    select c.id, c.chunk_id, c.text, c.page_start, c.page_end, b.title, b.author, b.paginated
    from chunks c join books b on b.id = c.book_id
    where c.id in (${top.map(() => "?").join(",")})
  `).all(...top.map(([id]) => id)) as any[];

  const byId = new Map(rows.map((r) => [r.id, r]));
  return top.map(([id, score]) => ({ ...byId.get(id), score })).filter((h) => h.id);
}

/** How guru cites: [Title, Author, p. N] — or chapter/paragraph when the source has no pages. */
export function cite(h: Hit) {
  const where = h.paginated
    ? `p. ${h.page_start}${h.page_end !== h.page_start ? `-${h.page_end}` : ""}`
    : h.page_start;
  return `[${h.title}, ${h.author}, ${where}]`;
}
