import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { profile, PROFILE_PATH } from "../src/profile.ts";

export type Case = { query: string; expect: string; book?: string; source?: string; split?: "dev" | "holdout"; scope?: { title: string; author: string } };
export function readCases(file: string, source = "hand"): Case[] {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(value)) throw new Error(`Invalid evaluation cases: ${file}`);
  return value.map((c) => {
    if (!c || typeof c.query !== "string" || !c.query.trim() || typeof c.expect !== "string" || !c.expect.trim()) throw new Error(`Invalid evaluation case: ${file}`);
    if (c.source !== undefined && (typeof c.source !== "string" || !c.source.trim())) throw new Error(`Invalid evaluation source: ${file}`);
    if (c.split !== undefined && !["dev", "holdout"].includes(c.split)) throw new Error(`Invalid evaluation split: ${file}`);
    if (c.scope !== undefined && (!c.scope || Object.keys(c.scope).some((k) => !["title", "author"].includes(k)) ||
        [c.scope.title, c.scope.author].some((s) => typeof s !== "string" || !s.trim()))) throw new Error(`Invalid evaluation scope: ${file}`);
    return { ...c, source: c.source ?? source } as Case;
  });
}

export function loadCases(handOnly = false): Case[] {
  const files = handOnly ? profile.evaluation.slice(0, 1) : profile.evaluation;
  const cases = files.flatMap((file, index) => readCases(file, index === 0 ? "hand" : "gen"));
  if (!cases.length) throw new Error("No evaluation cases configured");
  return cases;
}

export function caseSplit(c: Case): "dev" | "holdout" {
  return c.split ?? (createHash("sha256").update(c.query).digest()[0] % 2 ? "holdout" : "dev");
}

export function sampleCases<T>(cases: T[], limit: number): T[] {
  if (limit === Infinity) return cases;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Evaluation limit must be a positive integer");
  if (limit >= cases.length) return cases;
  return Array.from({ length: limit }, (_, i) => cases[Math.floor(i * cases.length / limit)]);
}

export function corpusIdentity(db: Database.Database) {
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
  const current = corpusIdentity(db);
  if (!saved || saved.kind !== kind || Object.entries(current).some(([key, value]) => saved[key] !== value) || !Array.isArray(saved.items)) {
    throw new Error("Frozen evaluation cache does not match this profile and corpus. Use a new cache path.");
  }
  return saved.items;
}
export function writeFrozen<T>(file: string, db: Database.Database, kind: string, items: T[]) {
  if (file) writeFileSync(file, JSON.stringify({ ...corpusIdentity(db), kind, items }));
}

export function quotesExpected(answer: string, expected: string) {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  return answer.split("\n").filter((s) => s.startsWith("> ")).some((s) => flat(s.replace(/\s*\[[^\]]*\]\s*$/, "").slice(2)).includes(flat(expected)));
}
