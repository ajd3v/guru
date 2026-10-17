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
  const ADDRESS_LIMIT = 10;
  const ACCOUNT_LIMIT = 20;
  const WINDOW_MS = 15 * 60 * 1000;
  const ADDRESS_CAPACITY = 10_000;
  const TRUST_MS = 30 * 24 * 60 * 60 * 1000;
  const TRUSTED_ADDRESS_LIMIT = 20;
  type Counter = { count: number; until: number };
  const addresses = new Map<string, Counter>();
  // Callers pass only known readers, bounding both account maps by the reader count.
  const accounts = new Map<string, Counter>();
  const trusted = new Map<string, Map<string, number>>();
  const prune = (now: number) => {
    for (const entries of [addresses, accounts]) {
      for (const [key, value] of entries) if (value.until <= now) entries.delete(key);
    }
  };
  const increment = (entries: Map<string, Counter>, key: string, now: number, capacity = Infinity) => {
    const value = entries.get(key);
    if (value) value.count++;
    else if (entries.size < capacity) entries.set(key, { count: 1, until: now + WINDOW_MS });
  };
  return {
    failed(ip: string, account?: string, now = Date.now()) {
      prune(now);
      increment(addresses, ip, now, ADDRESS_CAPACITY);
      if (account) increment(accounts, account, now);
    },
    succeeded(ip: string, account?: string, now = Date.now()) {
      if (!account) return;
      const entries = trusted.get(account) ?? new Map<string, number>();
      for (const [address, until] of entries) if (until <= now) entries.delete(address);
      entries.delete(ip);
      entries.set(ip, now + TRUST_MS);
      if (entries.size > TRUSTED_ADDRESS_LIMIT) entries.delete(entries.keys().next().value!);
      trusted.set(account, entries);
    },
    blocked(ip: string, account?: string, now = Date.now()) {
      prune(now);
      // During an active attack, a reader on a new device gets 429 until the window passes.
      return (addresses.get(ip)?.count ?? 0) >= ADDRESS_LIMIT ||
        !!account && (accounts.get(account)?.count ?? 0) >= ACCOUNT_LIMIT &&
        (trusted.get(account)?.get(ip) ?? 0) <= now;
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
