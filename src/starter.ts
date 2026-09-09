import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { profile, PROFILE_PATH, PYTHON, SIDECAR } from "./profile.ts";

type Entry = { author: string; title: string; gutenberg?: number; url?: string; build?: string; path?: string; page_offset?: number };
export const STARTER_DIR = process.env.GURU_STARTER_FILES ?? "data/starter";
const root = dirname(PROFILE_PATH);

export function manifest(): Entry[] {
  const entries = JSON.parse(readFileSync(profile.library, "utf8"));
  if (!Array.isArray(entries)) throw new Error("Library manifest must be an array");
  for (const e of entries) {
    if (!e || [e.author, e.title].some((s) => typeof s !== "string" || !s || basename(s) !== s || s.includes("\\")) ||
        [e.gutenberg, e.url, e.build, e.path].filter((s) => s !== undefined).length !== 1 ||
        (e.page_offset !== undefined && !Number.isInteger(e.page_offset))) throw new Error("Invalid library entry");
    if (e.url && !/^https?:\/\//.test(e.url)) throw new Error("Library URL must use HTTP or HTTPS");
    if (e.gutenberg !== undefined && (!Number.isInteger(e.gutenberg) || e.gutenberg < 1)) throw new Error("Invalid catalogue id");
    for (const key of ["url", "build", "path"]) if (e[key] !== undefined && (typeof e[key] !== "string" || !e[key])) throw new Error(`Invalid library ${key}`);
  }
  return entries;
}

export function starterFingerprint() {
  const hash = createHash("sha256").update(readFileSync(profile.library)).update(readFileSync(SIDECAR));
  for (const entry of manifest()) {
    if (entry.build) hash.update(readFileSync(resolve(root, entry.build)));
    if (entry.path) hash.update(readFileSync(resolve(root, entry.path)));
  }
  return hash.digest("hex");
}

export async function fetchStarter(limit = Infinity) {
  const entries = manifest().slice(0, limit);
  mkdirSync(STARTER_DIR, { recursive: true });
  const paths: { path: string; pageOffset: number; metadata: { title: string; author: string; source: string } }[] = [];
  for (const entry of entries) {
    const extension = entry.gutenberg ? ".epub" : entry.path ? extname(entry.path) : entry.url && /\.epub$/i.test(new URL(entry.url).pathname) ? ".epub" : ".pdf";
    const path = entry.path ? resolve(root, entry.path) : join(STARTER_DIR, `${entry.author} - ${entry.title}${extension}`);
    const selector = JSON.stringify({ url: entry.url, gutenberg: entry.gutenberg });
    const sourceStamp = `${path}.source`;
    const sourceChanged = !!(entry.url || entry.gutenberg) && (!existsSync(sourceStamp) || readFileSync(sourceStamp, "utf8") !== selector);
    const builderHash = entry.build ? createHash("sha256").update(readFileSync(resolve(root, entry.build))).digest("hex") : "";
    const builderStamp = `${path}.builder`;
    const builderChanged = !!entry.build && (!existsSync(builderStamp) || readFileSync(builderStamp, "utf8") !== builderHash);
    if (!existsSync(path) || builderChanged || sourceChanged) {
      if (entry.path) throw new Error(`Missing source file: ${path}`);
      if (entry.build) {
        execFileSync(PYTHON, [resolve(root, entry.build), resolve(path)], { cwd: root, stdio: "inherit" });
        if (!existsSync(path)) throw new Error(`Source builder did not create ${path}`);
        writeFileSync(builderStamp, builderHash);
      } else {
        const url = entry.url ?? `https://www.gutenberg.org/ebooks/${entry.gutenberg}.epub3.images`;
        const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(120_000) });
        if (!response.ok) {
          if (entry.gutenberg && response.status === 404) { console.error(`Source unavailable: ${entry.title}`); continue; }
          throw new Error(`Source fetch failed (${response.status}): ${entry.title}`);
        }
        const temporary = `${path}.download`;
        writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
        renameSync(temporary, path);
        writeFileSync(sourceStamp, selector);
      }
      console.error(`fetched ${entry.title}`);
    }
    paths.push({ path, pageOffset: entry.page_offset ?? 0, metadata: { title: entry.title, author: entry.author, source: entry.path ?? basename(path) } });
  }
  return paths;
}
