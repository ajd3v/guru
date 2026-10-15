import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PYTHON, SIDECAR } from "./profile.ts";

const run = promisify(execFile);
let active = 0;

export async function renderPage(path: string, page: number) {
  if (active >= 2) return undefined;
  active++;
  try {
    return (await run(PYTHON, [SIDECAR, "--render", path, String(page)], {
      encoding: "buffer", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
    })).stdout;
  } finally { active--; }
}

/** Bounded fixed windows for expensive guest requests. */
export function requestLimit(max: number, window = 60_000) {
  const entries = new Map<string, { count: number; until: number }>();
  return (key: string, now = Date.now()) => {
    for (const [key, value] of entries) if (value.until <= now) entries.delete(key);
    const entry = entries.get(key);
    if (entry) return ++entry.count <= max;
    if (entries.size >= 10_000) return false;
    entries.set(key, { count: 1, until: now + window });
    return true;
  };
}
