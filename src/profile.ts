import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load environment settings before auth and storage read them during import.
try { if (process.env.GURU_NO_DOTENV !== "1") process.loadEnvFile(); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

export const ENGINE_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PYTHON = process.env.GURU_PYTHON ?? resolve(".venv/bin/python");
export const SIDECAR = resolve(ENGINE_ROOT, "ingest/ingest.py");

export type Profile = {
  version: number;
  id: string;
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  library: string;
  evaluation: string[];
  sourceRegister: string;
  queryExpansions: { terms: string[]; append: string }[];
  maxQuotesPerBook: number;
  vectorWeight: number;
  starterMode: "automatic" | "managed";
  assets: string;
  styles?: string;
  mark?: string;
  themeColor: string;
  backgroundColor: string;
  showControls: boolean;
  showQuota: boolean;
  cookieName: string;
  tokenNamespace: string;
  historyKey: string;
  dailyReading?: { book: string; label: string; timezone: string };
};

const defaults = {
  shortName: "", tagline: "", description: "A study companion for your library.",
  sourceRegister: "the works in this library", queryExpansions: [], maxQuotesPerBook: 1, vectorWeight: 1,
  starterMode: "automatic", assets: "assets", themeColor: "#f3efe3", backgroundColor: "#14150f",
  showControls: true, showQuota: false,
};

export function loadProfile(path: string): Profile {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Profile must be an object");
  const allowed = new Set([...Object.keys(defaults), "version", "id", "name", "library", "evaluation", "styles", "mark", "cookieName", "tokenNamespace", "historyKey", "dailyReading"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown profile field: ${key}`);
  const p = { ...defaults, ...value };
  if (p.version !== 1) throw new Error("Profile version must be 1");
  if (typeof p.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.id)) throw new Error("Invalid profile id");
  for (const key of ["name", "library", "sourceRegister"]) {
    if (typeof p[key] !== "string" || !p[key].trim()) throw new Error(`Profile requires ${key}`);
  }
  for (const key of ["shortName", "tagline", "description", "assets"]) {
    if (typeof p[key] !== "string") throw new Error(`Invalid profile ${key}`);
  }
  if (!Array.isArray(p.evaluation) || !p.evaluation.length || p.evaluation.some((s: unknown) => typeof s !== "string" || !s)) {
    throw new Error("Profile requires evaluation files for its own corpus");
  }
  if (!Number.isInteger(p.maxQuotesPerBook) || p.maxQuotesPerBook < 0 || p.maxQuotesPerBook > 20) throw new Error("Invalid maxQuotesPerBook");
  if (typeof p.vectorWeight !== "number" || !Number.isFinite(p.vectorWeight) || p.vectorWeight <= 0 || p.vectorWeight > 10) throw new Error("Invalid vectorWeight");
  if (!["automatic", "managed"].includes(p.starterMode)) throw new Error("Invalid starterMode");
  for (const key of ["showControls", "showQuota"]) if (typeof p[key] !== "boolean") throw new Error(`Invalid ${key}`);
  for (const key of ["themeColor", "backgroundColor"]) if (!/^#[0-9a-f]{6}$/i.test(p[key])) throw new Error(`Invalid ${key}`);
  p.cookieName ??= p.id;
  p.tokenNamespace ??= `${p.id}-link`;
  p.historyKey ??= `${p.id}-history`;
  for (const key of ["cookieName", "tokenNamespace", "historyKey"]) {
    if (typeof p[key] !== "string" || !/^[a-zA-Z0-9:_-]{1,80}$/.test(p[key])) throw new Error(`Invalid ${key}`);
  }
  if (!Array.isArray(p.queryExpansions)) throw new Error("Invalid queryExpansions");
  for (const rule of p.queryExpansions) {
    if (!rule || Object.keys(rule).some((key) => !["terms", "append"].includes(key)) ||
        !Array.isArray(rule.terms) || !rule.terms.length ||
        rule.terms.some((s: unknown) => typeof s !== "string" || !s.trim() || s.length > 100) ||
        typeof rule.append !== "string" || !rule.append.trim()) throw new Error("Invalid query expansion");
  }
  if (p.dailyReading !== undefined) {
    const r = p.dailyReading;
    if (!r || Object.keys(r).some((key) => !["book", "label", "timezone"].includes(key)) ||
        [r.book, r.label, r.timezone].some((s) => typeof s !== "string" || !s)) throw new Error("Invalid dailyReading");
    new Intl.DateTimeFormat("en-US", { timeZone: r.timezone });
  }
  const root = dirname(resolve(path));
  for (const key of ["library", "assets", "styles", "mark"]) {
    if (p[key] === undefined) continue;
    if (typeof p[key] !== "string" || !p[key]) throw new Error(`Invalid ${key}`);
    p[key] = resolve(root, p[key]);
    if (!existsSync(p[key])) throw new Error(`Missing profile ${key}: ${p[key]}`);
  }
  p.evaluation = p.evaluation.map((s: string) => resolve(root, s));
  p.shortName ||= p.name;
  return p as Profile;
}

const local = resolve("guru.config.json");
export const PROFILE_PATH = resolve(process.env.GURU_PROFILE ?? (existsSync(local) ? local : resolve(ENGINE_ROOT, "guru.config.json")));
export const profile = loadProfile(PROFILE_PATH);

export function broaden(query: string, rules = profile.queryExpansions) {
  const words = ` ${query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return rules.reduce((text, rule) => rule.terms.some((term) =>
    words.includes(` ${term.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `))
    ? `${text} ${rule.append}` : text, query);
}
