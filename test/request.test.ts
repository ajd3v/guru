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
assert.equal(failures.blocked("fresh-address", "reader", 1), true, "rotating addresses cannot bypass the account limit");
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
assert.equal(saturated.blocked("address-0", undefined, 900_000), false);
for (let i = 0; i < 10; i++) saturated.failed("fresh-address", "reader", 900_000);
assert.equal(saturated.blocked("fresh-address", "reader", 900_001), true, "expired entries free capacity for new counters");
console.log("proxy and sign-in limits ok");
