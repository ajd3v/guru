import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

const TRUST_PROXY = Number(process.env.GURU_TRUST_PROXY ?? 0);
if (!Number.isSafeInteger(TRUST_PROXY) || TRUST_PROXY < 0) throw new Error("GURU_TRUST_PROXY must be a nonnegative hop count");

export function clientAddress(req: IncomingMessage, hops = TRUST_PROXY) {
  const peer = req.socket?.remoteAddress ?? "unknown";
  if (!hops) return peer;
  const header = req.headers["x-forwarded-for"];
  if (typeof header !== "string") return peer;
  const chain = header.split(",").map((s) => s.trim());
  if (chain.length < hops || chain.some((s) => !isIP(s))) return peer;
  return chain[chain.length - hops];
}

export function requestOrigin(req: IncomingMessage, hops = TRUST_PROXY) {
  const forwarded = req.headers["x-forwarded-proto"];
  const protocol = hops && (forwarded === "https" || forwarded === "http") ? forwarded :
    (req.socket as IncomingMessage["socket"] & { encrypted?: boolean })?.encrypted ? "https" : "http";
  return new URL(`${protocol}://${req.headers.host ?? "localhost"}`).origin;
}

export function signInFailures() {
  const entries = new Map<string, { count: number; until: number }>();
  const keys = (ip: string, account?: string) => [`ip:${ip}`, ...(account ? [`account:${account}`] : [])];
  const prune = (now: number) => { for (const [key, value] of entries) if (value.until <= now) entries.delete(key); };
  return {
    failed(ip: string, account?: string, now = Date.now()) {
      prune(now);
      for (const key of keys(ip, account)) {
        const value = entries.get(key);
        if (value) value.count++;
        else if (entries.size < 10_000) entries.set(key, { count: 1, until: now + 900_000 });
      }
    },
    blocked(ip: string, account?: string, now = Date.now()) {
      prune(now);
      return keys(ip, account).some((key) => (entries.get(key)?.count ?? 0) >= 10);
    },
  };
}

export function safeMutation(req: IncomingMessage, allowed = (process.env.GURU_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true; // Authenticated command-line clients omit browser headers.
  if (typeof origin !== "string") return false;
  try {
    if (new URL(origin).origin !== origin) return false;
    return allowed.length ? allowed.includes(origin) : origin === requestOrigin(req);
  } catch { return false; }
}
