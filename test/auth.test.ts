import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.GURU_BASIC_AUTH = "reader:synthetic-password";
const { linkToken, sessionToken, tokenUser, cookieUser, SESSION_SECONDS } = await import("../src/auth.ts");
const { profile } = await import("../src/profile.ts");
const expected = ["reader:synthetic-password"];
const link = linkToken("reader")!;
assert.notEqual(link, linkToken("reader"));
assert.equal(tokenUser("reader", link), "reader");
assert.equal(tokenUser("other", link), undefined);
assert.equal(tokenUser("reader", link, ["reader:changed-password"]), undefined);
assert.equal(tokenUser("reader", link + "x"), undefined);
const old = createHash("sha256").update(`${profile.tokenNamespace}:${expected[0]}`).digest("base64url");
assert.equal(tokenUser("reader", old), undefined);
assert.equal(cookieUser(`${profile.cookieName}=${Buffer.from(expected[0]).toString("base64")}`), undefined);
assert.equal(cookieUser(`${profile.cookieName}=reader.${link}`), undefined, "links cannot serve as session cookies");
const session = sessionToken("reader")!;
assert.equal(cookieUser(`__Host-${profile.cookieName}=reader.${session}`), "reader");
assert.equal(tokenUser("reader", session), undefined, "session cookies cannot mint new sessions");
const now = Date.now;
try {
  Date.now = () => now() + 16 * 60 * 1000;
  assert.equal(tokenUser("reader", link), undefined);
  assert.equal(cookieUser(`${profile.cookieName}=reader.${session}`), "reader");
  Date.now = () => now() + (SESSION_SECONDS + 1) * 1000;
  assert.equal(cookieUser(`${profile.cookieName}=reader.${session}`), undefined);
} finally { Date.now = now; }
console.log("auth tests ok");
