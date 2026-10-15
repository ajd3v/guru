import type { IncomingMessage } from "node:http";

export function requestOrigin(req: IncomingMessage) {
  const protocol = req.headers["x-forwarded-proto"] ?? "http";
  return new URL(`${protocol}://${req.headers.host ?? "localhost"}`).origin;
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
