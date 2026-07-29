// Identity, isolated behind one function so the rest of the app only ever sees a user id.
//
// Clerk is used rather than anything hand-rolled: sessions, password storage, MFA, and token
// rotation are the parts of a SaaS most worth not owning. See SPEC.md.
import type { IncomingMessage } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
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

/**
 * Deliberate single-user mode: every request is this reader, whoever sent it.
 *
 * Only safe behind an authenticating proxy, because the app itself will no longer ask who
 * you are. It exists because "one person, their own domain" is a real deployment and Clerk
 * is premature for it — but it must be named explicitly. The guard below still refuses the
 * silent default, which is the case that hands one library to the whole internet by accident.
 */
const SINGLE_USER = process.env.GURU_SINGLE_USER;

/**
 * `user:password` guarding single-user mode.
 *
 * Enforced here rather than at the reverse proxy on purpose. The first attempt put it in a
 * Traefik middleware, and Coolify regenerated the router's label on deploy and dropped it —
 * the site came up with no authentication and nothing said so. A door this important should
 * not depend on another system's label-merge order, and in here it is testable.
 */
const BASIC_AUTH = process.env.GURU_BASIC_AUTH;

// A missing key must never silently degrade to "everyone is the same user" on a public
// box. Local development gets the fallback; production gets a boot failure.
if (PRODUCTION && !SECRET && !SINGLE_USER) {
  throw new Error(
    "CLERK_SECRET_KEY is required when NODE_ENV=production " +
      "(or set GURU_SINGLE_USER to run single-user behind an authenticating proxy)",
  );
}
// Only meaningful when Clerk is verifying tokens; single-user mode has no tokens to scope.
if (PRODUCTION && SECRET && !AUTHORIZED_PARTIES.length) {
  throw new Error("GURU_ORIGINS is required when NODE_ENV=production (e.g. https://guru.app)");
}
// Single-user mode serves one person's whole library to whoever asks, so in production it
// must come with a password. Refusing here makes the unsafe combination impossible rather
// than leaving it to whoever writes the deployment config to remember.
if (PRODUCTION && SINGLE_USER && !BASIC_AUTH) {
  throw new Error("GURU_BASIC_AUTH (user:password) is required alongside GURU_SINGLE_USER in production");
}

let clerk: ClerkClient | undefined;
if (SECRET) clerk = createClerkClient({ secretKey: SECRET, publishableKey: PUBLISHABLE });
else console.error("no CLERK_SECRET_KEY — every request resolves to the local dev user");

/**
 * Constant-time check of an `Authorization: Basic` header against `GURU_BASIC_AUTH`.
 *
 * Both sides are hashed before comparing so the buffers are the same length whatever was
 * sent — `timingSafeEqual` throws on a length mismatch, and the lengths themselves would
 * otherwise leak the size of the credential.
 */
export function basicAuthOk(header: string | undefined, expected = BASIC_AUTH) {
  if (!expected) return true;
  if (!header?.startsWith("Basic ")) return false;
  const given = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  return timingSafeEqual(
    createHash("sha256").update(given).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

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
  // Checked before Clerk: if both are configured, the explicit choice wins rather than
  // leaving which one applies to the order of two environment variables.
  if (SINGLE_USER) {
    if (BASIC_AUTH && !basicAuthOk(req.headers.authorization)) {
      return {
        kind: "respond",
        status: 401,
        headers: new Headers({ "www-authenticate": 'Basic realm="guru", charset="UTF-8"' }),
      };
    }
    return { kind: "user", userId: SINGLE_USER };
  }
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
