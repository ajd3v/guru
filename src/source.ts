import type Database from "better-sqlite3";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export class SourceChanged extends Error {
  constructor() { super("This source has changed or is no longer available. Search the library again to open its current edition."); }
}

export type Source = { id: number; title: string; author: string; source: string; revision: string; bytes: number; page_offset: number; paginated: number; extraction_quality: string | null };

/** A citation is valid only within the current reader's library and its recorded revision. */
export function sourceBook(db: Database.Database, id: string | null, revision: string | null): Source {
  if (!id || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || !revision || !/^[a-f0-9]{32}$/.test(revision)) throw new SourceChanged();
  const row = db.prepare("select id, title, author, source, revision, coalesce(length(pdf), 0) bytes, page_offset, paginated, extraction_quality from books where id = ? and revision = ?").get(Number(id), revision) as Source | undefined;
  if (!row) throw new SourceChanged();
  return row;
}

export function sourceContext(db: Database.Database, source: Source, chunk: string | null) {
  if (!chunk || !/^[1-9]\d*$/.test(chunk) || !Number.isSafeInteger(Number(chunk))) throw new SourceChanged();
  const row = db.prepare("select c.id, c.chunk_id, c.text, c.page_start, c.page_end from chunks c join books b on b.id = c.book_id where c.id = ? and c.book_id = ? and b.revision = ?").get(Number(chunk), source.id, source.revision) as { id: number; chunk_id: number; text: string; page_start: string; page_end: string } | undefined;
  if (!row) throw new SourceChanged();
  const neighbor = (direction: string, order: string) => (db.prepare(`select c.id from chunks c join books b on b.id = c.book_id where c.book_id = ? and c.chunk_id ${direction} ? and b.revision = ? order by c.chunk_id ${order} limit 1`).get(source.id, row.chunk_id, source.revision) as { id: number } | undefined)?.id;
  return { ...row, previous: neighbor("<", "desc"), next: neighbor(">", "asc") };
}

/** One HTTP range, inclusive at both ends. Invalid and unsatisfiable requests return null. */
export function byteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && end >= start ? { start, end: Math.min(end, size - 1) } : null;
}

/** Read bounded BLOB slices so a page request never copies the entire PDF into Node memory. */
export async function streamPdf(req: IncomingMessage, res: ServerResponse, db: Database.Database, source: Source) {
  if (!source.bytes) { res.writeHead(404).end("The original PDF is not stored for this edition."); return; }
  const etag = `"${source.revision}"`;
  res.setHeader("content-type", "application/pdf");
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("etag", etag);
  res.setHeader("cache-control", "private, no-cache");
  res.setHeader("content-disposition", `inline; filename="source.pdf"; filename*=UTF-8''${encodeURIComponent(source.title + ".pdf").replace(/'/g, "%27")}`);
  if (req.headers["if-none-match"] === etag) { res.writeHead(304).end(); return; }
  const rangeHeader = !req.headers["if-range"] || req.headers["if-range"] === etag ? req.headers.range : undefined;
  const range = rangeHeader ? byteRange(rangeHeader, source.bytes) : { start: 0, end: source.bytes - 1 };
  if (!range) { res.writeHead(416, { "content-range": `bytes */${source.bytes}` }).end(); return; }
  if (rangeHeader) res.setHeader("content-range", `bytes ${range.start}-${range.end}/${source.bytes}`);
  res.setHeader("content-length", range.end - range.start + 1);
  res.writeHead(rangeHeader ? 206 : 200);
  if (req.method === "HEAD") { res.end(); return; }
  const slice = db.prepare("select substr(pdf, ?, ?) data from books where id = ? and revision = ?");
  async function* chunks() {
    for (let start = range!.start; start <= range!.end; start += 64 * 1024) {
      const row = slice.get(start + 1, Math.min(64 * 1024, range!.end - start + 1), source.id, source.revision) as { data: Buffer } | undefined;
      if (!row?.data?.length) throw new SourceChanged();
      yield row.data;
    }
  }
  await pipeline(Readable.from(chunks()), res);
}
