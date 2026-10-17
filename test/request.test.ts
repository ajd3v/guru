import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { safeMutation, clientAddress, requestOrigin, signInFailures } from "../src/request.ts";

const req = (headers: Record<string, string> = {}) => ({ headers: { host: "reader.example", ...headers }, socket: {} }) as IncomingMessage;
assert.equal(safeMutation(req()), true);
assert.equal(safeMutation(req({ origin: "http://reader.example" })), true);
for (const site of [undefined, "same-site", "same-origin", "none", "cross-site"]) {
  for (const origin of ["https://evil.example", "null", "http://reader.example.evil", "http://reader.example/path", "http://reader.example@evil.example"]) {
    assert.equal(safeMutation(req({ origin, ...(site ? { "sec-fetch-site": site } : {}) })), false);
  }
}
assert.equal(safeMutation(req({ "sec-fetch-site": "same-site" })), false);
assert.equal(safeMutation(req({ "sec-fetch-site": "cross-site", origin: "http://reader.example" })), false);
assert.equal(safeMutation(req({ origin: "https://public.example" }), ["https://public.example"]), true);
assert.equal(safeMutation(req({ origin: "http://reader.example" }), ["https://public.example"]), false);
console.log("request origin tests ok");
const forwarded = { headers: { host: "reader.example", "x-forwarded-for": "198.51.100.1, 203.0.113.2", "x-forwarded-proto": "https" }, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage;
assert.equal(clientAddress(forwarded), "127.0.0.1");
assert.equal(clientAddress(forwarded, 1), "203.0.113.2");
assert.equal(clientAddress(forwarded, 2), "198.51.100.1");
assert.equal(clientAddress(forwarded, 3), "127.0.0.1");
assert.equal(clientAddress(req({ "x-forwarded-for": "invalid" }), 1), "unknown");
assert.equal(requestOrigin(forwarded), "http://reader.example");
assert.equal(requestOrigin(forwarded, 1), "https://reader.example");
const failures = signInFailures();
for (let i = 0; i < 10; i++) failures.failed(`address-${i}`, "reader", 0);
assert.equal(failures.blocked("fresh-address", "reader", 1), false, "the account allows twenty failures");
for (let i = 1; i < 10; i++) failures.failed("address-0", "reader", 1);
assert.equal(failures.blocked("address-0", "reader", 1), true, "an exhausted address is blocked");
assert.equal(failures.blocked("address-1", "reader", 1), false);
assert.equal(failures.blocked("fresh-address", "other", 1), false);
for (let i = 0; i < 10; i++) failures.failed("fixed-address", `account-${i}`, 0);
assert.equal(failures.blocked("fixed-address", "fresh-account", 1), true);
assert.equal(failures.blocked("fixed-address", "reader", 900_000), false);
const saturated = signInFailures();
for (let i = 0; i < 10_000; i++) saturated.failed(`address-${i}`, undefined, 0);
assert.equal(saturated.blocked("fresh-address", "reader", 1), false, "a full map cannot block unrelated readers");
assert.equal(saturated.blocked("address-0", undefined, 1), false, "a retained key still needs ten failures");
for (let i = 1; i < 10; i++) saturated.failed("address-0", undefined, 1);
assert.equal(saturated.blocked("address-0", undefined, 1), true, "retained counters still enforce their limit at capacity");
for (let i = 0; i < 10; i++) saturated.failed("overflow-address", "overflow-reader", 1);
assert.equal(saturated.blocked("overflow-address", "overflow-reader", 1), false, "overflow keys are not retained");
for (let i = 0; i < 10; i++) saturated.failed(`overflow-${i}`, "overflow-reader", 1);
assert.equal(saturated.blocked("different-address", "overflow-reader", 1), true, "a full address map cannot disable the separate account counter");
assert.equal(saturated.blocked("different-address", "other-reader", 1), false, "a full address map cannot trip another account");
assert.equal(saturated.blocked("address-0", undefined, 900_000), false);
for (let i = 0; i < 10; i++) saturated.failed("fresh-address", "reader", 900_000);
assert.equal(saturated.blocked("fresh-address", "reader", 900_001), true, "expired entries free capacity for new counters");
const rotating = signInFailures();
rotating.succeeded("trusted-address", "reader", 0);
let blocked = 0;
for (let i = 0; i < 25; i++) {
  const ip = `rotating-${i}`;
  if (rotating.blocked(ip, "reader", 1)) blocked++;
  else rotating.failed(ip, "reader", 1);
}
assert.equal(blocked, 5, "twenty failures across addresses throttle further guesses");
assert.equal(rotating.blocked("trusted-address", "reader", 2), false, "trusted addresses survive an account attack");
assert.equal(rotating.blocked("trusted-address", "other-reader", 2), false);
for (let i = 0; i < 10; i++) rotating.failed("trusted-address", "reader", 2);
assert.equal(rotating.blocked("trusted-address", "reader", 3), true, "trust does not bypass the address limit");
assert.equal(rotating.blocked("new-address", "reader", 900_001), false, "account failures expire after fifteen minutes");

const trust = signInFailures();
const day = 24 * 60 * 60 * 1000;
trust.succeeded("old-address", "reader", 0);
trust.succeeded("refreshed-address", "reader", 0);
trust.succeeded("refreshed-address", "reader", day);
for (let i = 0; i < 20; i++) trust.failed(`attack-${i}`, "reader", 30 * day);
assert.equal(trust.blocked("old-address", "reader", 30 * day), true, "trust expires after thirty days");
assert.equal(trust.blocked("refreshed-address", "reader", 30 * day), false, "a successful sign-in renews trust");
assert.equal(trust.blocked("refreshed-address", "other-reader", 30 * day), false);
for (let i = 0; i < 20; i++) trust.failed(`other-attack-${i}`, "other-reader", 30 * day);
assert.equal(trust.blocked("refreshed-address", "other-reader", 30 * day), true, "trust belongs to one account");

const capped = signInFailures();
for (let i = 0; i < 20; i++) capped.succeeded(`device-${i}`, "reader", i);
capped.succeeded("device-0", "reader", 20);
capped.succeeded("new-device", "reader", 21);
for (let i = 0; i < 20; i++) capped.failed(`attack-${i}`, "reader", 22);
assert.equal(capped.blocked("device-1", "reader", 23), true, "the oldest trusted address is evicted at capacity");
assert.equal(capped.blocked("device-0", "reader", 23), false, "renewed trust moves an address to the end");
assert.equal(capped.blocked("new-device", "reader", 23), false, "new trust is retained at capacity");

const unknown = signInFailures();
const set = Map.prototype.set;
let writes = 0;
Map.prototype.set = function (key, value) { writes++; return set.call(this, key, value); };
try { unknown.failed("unknown-address", undefined, 0); }
finally { Map.prototype.set = set; }
assert.equal(writes, 1, "an unknown name only creates an address entry");
console.log("proxy and sign-in limits ok");
