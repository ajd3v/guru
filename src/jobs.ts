// Ingest queue. A book takes minutes of CPU to parse and embed, which is far too long to
// hold a request open and far too much work to do on the server's event loop, so uploads are
// written to disk, recorded here, and picked up by `guru worker` in its own process.
//
// SQLite rather than a queue service: the jobs are low-volume, the database is already a
// dependency, and a crashed worker leaves the row behind to be retried instead of losing it.
import Database from "better-sqlite3";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type JobState = "receiving" | "queued" | "running" | "done" | "failed";

export type Job = {
  id: number;
  user_id: string;
  path: string;
  filename: string;
  state: JobState;
  error: string | null;
  created_at: string;
  attempts: number;
};

export function openJobs(path = process.env.GURU_JOBS_DB ?? "data/jobs.db") {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    create table if not exists jobs (
      id integer primary key,
      user_id text not null,
      path text not null,
      filename text not null,
      state text not null default 'queued',
      error text,
      created_at text not null default (datetime('now'))
    );
    create index if not exists jobs_by_user on jobs (user_id, id desc);
    create index if not exists jobs_by_state on jobs (state, id);
  `);
  db.transaction(() => {
    const columns = db.prepare("pragma table_info(jobs)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "attempts")) db.exec("alter table jobs add column attempts integer not null default 0");
    if (!columns.some((c) => c.name === "upload_bytes")) {
      db.exec("alter table jobs add column upload_bytes integer not null default 0");
      const rows = db.prepare("select id, path from jobs where state in ('queued','running')").all() as { id: number; path: string }[];
      for (const row of rows) db.prepare("update jobs set upload_bytes = ? where id = ?")
        .run(statSync(row.path, { throwIfNoEntry: false })?.size ?? 0, row.id);
    }
  }).immediate();
  return db;
}

export function enqueue(db: Database.Database, userId: string, path: string, filename: string) {
  return db
    .prepare("insert into jobs (user_id, path, filename) values (?,?,?)")
    .run(userId, path, filename).lastInsertRowid as number;
}

/**
 * Take the oldest queued job, or nothing.
 *
 * The select is inside the update on purpose: a read-then-write pair lets two workers claim
 * the same row and ingest one book twice. A single statement cannot interleave, so the state
 * change is the claim.
 */
export function claim(db: Database.Database): Job | undefined {
  return db
    .prepare(
      `update jobs set state = 'running', attempts = attempts + 1
       where id = (select id from jobs where state = 'queued' order by id limit 1)
       returning *`,
    )
    .get() as Job | undefined;
}

export function finish(db: Database.Database, id: number, error?: string) {
  db.prepare("update jobs set state = ?, error = ? where id = ?").run(
    error ? "failed" : "done",
    error ?? null,
    id,
  );
}

/** A worker killed mid-book leaves a row claimed forever. Hand them back at startup. */
export function requeueStale(db: Database.Database) {
  const rows = db.prepare(`update jobs set
    state = case when attempts >= 3 then 'failed' else 'queued' end,
    error = case when attempts >= 3 then 'Worker stopped repeatedly while processing this file.' else null end
    where state = 'running' returning path, state`).all() as { path: string; state: string }[];
  for (const row of rows) if (row.state === "failed") rmSync(row.path, { force: true });
  return rows.length;
}

export const listJobs = (db: Database.Database, userId: string, limit = 20) =>
  db
    .prepare("select * from jobs where user_id = ? order by id desc limit ?")
    .all(userId, limit) as Job[];

export const countActive = (db: Database.Database, userId: string) =>
  (
    db
      .prepare("select count(*) n from jobs where user_id = ? and state in ('receiving','queued','running')")
      .get(userId) as { n: number }
  ).n;

/** Reserve before reading the body. The queue lock also excludes worker completion. */
export function reserveUpload(db: Database.Database, user: string, path: string, filename: string,
  held: () => number, maxBooks: number, bytes: number, maxBytes: number) {
  return db.transaction(() => {
    const books = held();
    const used = (db.prepare("select coalesce(sum(upload_bytes), 0) n from jobs where user_id = ? and state in ('receiving','queued','running')").get(user) as { n: number }).n;
    if (books + countActive(db, user) >= maxBooks || used + bytes > maxBytes) return undefined;
    return db.prepare("insert into jobs (user_id, path, filename, state, upload_bytes) values (?,?,?,'receiving',?)")
      .run(user, path, filename, bytes).lastInsertRowid as number;
  }).immediate();
}

export function completeUpload(db: Database.Database, id: number, bytes: number, path: string) {
  return db.prepare("update jobs set state = 'queued', upload_bytes = ? where id = ? and path = ? and state = 'receiving'").run(bytes, id, path).changes === 1;
}

/** Only the server calls this at startup, before accepting new uploads. */
export function discardReceiving(db: Database.Database) {
  const rows = db.prepare("delete from jobs where state = 'receiving' returning path").all() as { path: string }[];
  for (const row of rows) rmSync(row.path, { force: true });
}
