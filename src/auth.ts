// Identity, isolated behind one function so the rest of the app only ever sees a user id.
//
// Clerk is used rather than anything hand-rolled: sessions, password storage, MFA, and token
// rotation are the parts of a SaaS most worth not owning. See SPEC.md.
import type { IncomingMessage } from "node:http";
import { createClerkClient, type ClerkClient } from "@clerk/backend";

/**
 * What the server should do with a request. `respond` carries Clerk's own headers verbatim:
 * the handshake flow sets cookies and a Location that must survive untouched, and rewriting
 * them by hand is how people end up in a redirect loop.
 */
export type Auth =
  | { kind: "user"; userId: string }
  | { kind: "respond"; status: number; headers: Headers };

const SECRET = process.env.CLERK_SECRET_KEY;
const PUBLISHABLE = process.env.CLERK_PUBLISHABLE_KEY;

/**
 * Origins allowed to present a session token. Without this a token minted for another site
 * on the same Clerk instance is accepted here, so it is required in production rather than
 * defaulted to something permissive.
 */
const AUTHORIZED_PARTIES = (process.env.GURU_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PRODUCTION = process.env.NODE_ENV === "production";

// A missing key must never silently degrade to "everyone is the same user" on a public
// box. Local development gets the fallback; production gets a boot failure.
if (PRODUCTION && !SECRET) {
  throw new Error("CLERK_SECRET_KEY is required when NODE_ENV=production");
}
if (PRODUCTION && !AUTHORIZED_PARTIES.length) {
  throw new Error("GURU_ORIGINS is required when NODE_ENV=production (e.g. https://guru.app)");
}

let clerk: ClerkClient | undefined;
if (SECRET) clerk = createClerkClient({ secretKey: SECRET, publishableKey: PUBLISHABLE });
else console.error("no CLERK_SECRET_KEY — every request resolves to the local dev user");

/** Node's request is not a fetch Request, and Clerk wants the latter. Headers and URL only. */
export function toWebRequest(req: IncomingMessage): Request {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const url = new URL(req.url ?? "/", `${proto}://${req.headers.host ?? "localhost"}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }
  // Body is deliberately not forwarded: authentication reads cookies and headers, and the
  // route handler still needs to consume the stream itself.
  return new Request(url, { method: req.method, headers });
}

export async function authenticate(req: IncomingMessage): Promise<Auth> {
  if (!clerk) return { kind: "user", userId: process.env.GURU_USER ?? "demo" };

  const state = await clerk.authenticateRequest(toWebRequest(req), {
    ...(AUTHORIZED_PARTIES.length ? { authorizedParties: AUTHORIZED_PARTIES } : {}),
  });

  // Clerk needs a round trip to set or refresh the session cookie. Its headers already say
  // where to go and what to set, so pass them through and return no body.
  if (state.status === "handshake") {
    return { kind: "respond", status: 307, headers: state.headers };
  }

  if (state.isAuthenticated) {
    const { userId } = state.toAuth();
    if (userId) return { kind: "user", userId };
  }

  const back = encodeURIComponent(toWebRequest(req).url);
  const headers = new Headers(state.headers);
  headers.set("location", `${state.signInUrl}?redirect_url=${back}`);
  return { kind: "respond", status: 302, headers };
}
