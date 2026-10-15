import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { safeMutation } from "../src/request.ts";

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
