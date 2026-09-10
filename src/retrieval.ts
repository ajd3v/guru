import type Database from "better-sqlite3";
import { CANDIDATES, search, type Hit } from "./store.ts";
import { broaden } from "./profile.ts";
import { expandQuery, rerank } from "./llm.ts";

/** Experimental fusion preserves a separate original-query vote. Both lists keep their source scope. */
export function fuseQueries(lists: Hit[][], limit = CANDIDATES): Hit[] {
  const rows = new Map<number, Hit>();
  const scores = new Map<number, number>();
  for (const hits of lists) for (const [rank, hit] of hits.entries()) {
    rows.set(hit.id, hit); scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (61 + rank));
  }
  return [...rows.values()].sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || a.id - b.id).slice(0, limit).map((hit) => ({ ...hit, score: scores.get(hit.id)! }));
}

/** Neighbors remain separate source records so their quotations keep their own page citations. */
export function adjacentContext(db: Database.Database, hits: Hit[]): Hit[] {
  const out = new Map<number, Hit>();
  for (const hit of hits) {
    out.set(hit.id, hit);
    if (!hit.book_id || !hit.revision) continue;
    for (const direction of ["<", ">"] as const) {
      const row = db.prepare(`select c.*, b.title, b.author, b.paginated, b.revision from chunks c join books b on b.id = c.book_id
        where c.book_id = ? and b.revision = ? and c.chunk_id ${direction} ? order by c.chunk_id ${direction === "<" ? "desc" : "asc"} limit 1`).get(hit.book_id, hit.revision, hit.chunk_id) as Hit | undefined;
      if (row) out.set(row.id, { ...row, score: hit.score });
    }
  }
  return [...out.values()];
}

export async function retrieveQuestion(db: Database.Database, query: string, options: { bookIds?: number[]; method?: "expanded" | "paired"; context?: boolean; expanded?: string } = {}) {
  const started = performance.now();
  const expanded = options.expanded ?? await expandQuery(query);
  const expandedMs = performance.now() - started;
  const scopes = options.bookIds && options.bookIds.length > 1 ? options.bookIds.map((id) => [id]) : [options.bookIds];
  const groups = await Promise.all(scopes.map(async (bookIds) => {
    const start = performance.now();
    const generated = await search(db, expanded, CANDIDATES, { literalQuery: query, bookIds });
    const candidates = options.method === "paired" ? fuseQueries([await search(db, broaden(query), CANDIDATES, { literalQuery: query, bookIds }), generated]) : generated;
    const searchMs = performance.now() - start;
    const ranked = await rerank(query, candidates, scopes.length > 1 ? 3 : 5);
    return { bookIds, candidates, ranked, searchMs, rerankMs: performance.now() - start - searchMs };
  }));
  const ranked = groups.flatMap((g) => g.ranked);
  return { expanded, groups, ranked, hits: options.context ? adjacentContext(db, ranked) : ranked, expandedMs, totalMs: performance.now() - started };
}
