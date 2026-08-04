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
 * Runs the app without Clerk, and names the reader when nothing else does.
 *
 * With GURU_BASIC_AUTH set this is only the mode switch, and the credential that matched
 * says who the reader is. On its own it means every request is this one reader whoever sent
 * it, which is only safe behind an authenticating proxy, because the app itself will no
 * longer ask who you are. It exists because "the people I know, on my own domain" is a real
 * deployment and Clerk is premature for it, but it must be named explicitly. The guard below
 * still refuses the silent default, the case that hands a library to the whole internet.
 */
const SINGLE_USER = process.env.GURU_SINGLE_USER;

/**
 * `user:password` credentials, comma-separated, guarding the app.
 *
 * The username that matches becomes the reader's id, so each credential gets its own
 * library. Two or three people who know each other need a password each, not a signup flow,
 * and Clerk stays the answer the day strangers can sign up.
 *
 * Enforced here rather than at the reverse proxy on purpose. The first attempt put it in a
 * Traefik middleware, and Coolify regenerated the router's label on deploy and dropped it ,
 * the site came up with no authentication and nothing said so. A door this important should
 * not depend on another system's label-merge order, and in here it is testable.
 */
const BASIC_AUTH = (process.env.GURU_BASIC_AUTH ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
if (PRODUCTION && SINGLE_USER && !BASIC_AUTH.length) {
  throw new Error("GURU_BASIC_AUTH (user:password) is required alongside GURU_SINGLE_USER in production");
}
/** The username half of `user:password`, or "" if there is no password to separate it from. */
function username(cred: string) {
  const at = cred.indexOf(":");
  return at > 0 ? cred.slice(0, at) : "";
}

// A username becomes a filename in GURU_USER_DIR, so it has to survive `libraryPath`. Checked
// at boot rather than on the request that first uses it, because a typo in the deployment
// config should be a refusal to start, not one reader's 500 an hour later. Mirrors the
// pattern in store.ts, which cannot be imported here without dragging SQLite in with it.
for (const cred of BASIC_AUTH) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(username(cred))) {
    throw new Error(`GURU_BASIC_AUTH entry is not user:password with a usable username: ${JSON.stringify(cred.slice(0, 12))}…`);
  }
}

let clerk: ClerkClient | undefined;
if (SECRET) clerk = createClerkClient({ secretKey: SECRET, publishableKey: PUBLISHABLE });
else console.error("no CLERK_SECRET_KEY, every request resolves to the local dev user");

/**
 * The username whose `user:password` matches an `Authorization: Basic` header, or undefined
 * if none does.
 *
 * Both sides are hashed before comparing so the buffers are the same length whatever was
 * sent, `timingSafeEqual` throws on a length mismatch, and the lengths themselves would
 * otherwise leak the size of the credential. Every credential is compared even once one has
 * matched, so how long the check takes does not say which reader was named.
 */
export function basicAuthUser(header: string | undefined, expected = BASIC_AUTH) {
  if (!header?.startsWith("Basic ")) return undefined;
  const given = createHash("sha256")
    .update(Buffer.from(header.slice(6).trim(), "base64").toString("utf8"))
    .digest();

  let matched: string | undefined;
  for (const cred of expected) {
    if (timingSafeEqual(given, createHash("sha256").update(cred).digest())) matched = username(cred);
  }
  return matched;
}

/**
 * Who may add books to the shelf and take the whole library away, comma-separated.
 *
 * Reading is what a reader is given; the corpus itself is not. Uploading runs a PDF parser
 * on a file the app then keeps, and exporting hands back a single SQLite file containing
 * every book in it, so between them they are the two doors that move literature rather than
 * answers. Unset means everyone, which is right for a one-person deployment and for the CLI,
 * where the only reader is the owner.
 *
 * Deletion is deliberately not gated. A reader removing their own library is their right and
 * takes nothing away from anybody else.
 */
const LIBRARIANS = (process.env.GURU_LIBRARIAN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Whether this reader may upload or export. True for everyone when none is named. */
export const isLibrarian = (userId: string, allowed = LIBRARIANS) =>
  !allowed.length || allowed.includes(userId);

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
    // No credentials configured means the proxy in front is the door, and everyone through
    // it is the one named reader. With credentials, whoever they signed in as is who they
    // are, which is what gives a second person their own library rather than a copy of the
    // first person's.
    if (!BASIC_AUTH.length) return { kind: "user", userId: SINGLE_USER };

    const user = basicAuthUser(req.headers.authorization);
    if (!user) {
      return {
        kind: "respond",
        status: 401,
        headers: new Headers({ "www-authenticate": 'Basic realm="guru", charset="UTF-8"' }),
      };
    }
    return { kind: "user", userId: user };
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
