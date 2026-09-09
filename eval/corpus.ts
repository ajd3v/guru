import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { profile, PROFILE_PATH } from "../src/profile.ts";

export type Case = { query: string; expect: string; book?: string; source?: string };
export function loadCases(handOnly = false): Case[] {
  const files = handOnly ? profile.evaluation.slice(0, 1) : profile.evaluation;
  const cases = files.flatMap((file, index) => {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(value)) throw new Error(`Invalid evaluation cases: ${file}`);
    return value.map((c) => {
      if (!c || typeof c.query !== "string" || !c.query.trim() || typeof c.expect !== "string" || !c.expect.trim()) throw new Error(`Invalid evaluation case: ${file}`);
      return { ...c, source: index === 0 ? "hand" : "gen" } as Case;
    });
  });
  if (!cases.length) throw new Error("No evaluation cases configured");
  return cases;
}

export function sampleCases<T>(cases: T[], limit: number): T[] {
  if (limit === Infinity) return cases;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Evaluation limit must be a positive integer");
  if (limit >= cases.length) return cases;
  return Array.from({ length: limit }, (_, i) => cases[Math.floor(i * cases.length / limit)]);
}

function identity(db: Database.Database) {
  const hash = createHash("sha256");
  for (const row of db.prepare("select b.id, b.title, b.author, b.source, c.id chunk_id, c.text, c.page_start, c.page_end from books b join chunks c on c.book_id = b.id order by b.id, c.id").iterate()) hash.update(JSON.stringify(row));
  return {
    version: 1,
    profile: createHash("sha256").update(readFileSync(PROFILE_PATH)).digest("hex"),
    corpus: hash.digest("hex"),
    cases: createHash("sha256").update(JSON.stringify(loadCases())).digest("hex"),
  };
}
export function readFrozen<T>(file: string, db: Database.Database, kind: string): T[] {
  if (!file || !existsSync(file)) return [];
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const current = identity(db);
  if (!saved || saved.kind !== kind || Object.entries(current).some(([key, value]) => saved[key] !== value) || !Array.isArray(saved.items)) {
    throw new Error("Frozen evaluation cache does not match this profile and corpus. Use a new cache path.");
  }
  return saved.items;
}
export function writeFrozen<T>(file: string, db: Database.Database, kind: string, items: T[]) {
  if (file) writeFileSync(file, JSON.stringify({ ...identity(db), kind, items }));
}

export function quotesExpected(answer: string, expected: string) {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  return answer.split("\n").filter((s) => s.startsWith("> ")).some((s) => flat(s.replace(/\s*\[[^\]]*\]\s*$/, "").slice(2)).includes(flat(expected)));
}
