// The OpenAI-compatible path: provider selection, the Anthropic -> OpenAI body
// translation, and one real round trip against a stub. No key, no tokens.
// Run: node test/openai.test.ts
import { createServer } from "node:http";
import assert from "node:assert";
import { _resetLlmConfig, expandQuery, resolveProvider, toOpenAiBody } from "../src/llm.ts";

// --- provider selection --------------------------------------------------

assert.equal(resolveProvider({} as NodeJS.ProcessEnv), "anthropic", "defaults to anthropic");
assert.equal(
  resolveProvider({ DEEPINFRA_BASE_URL: "https://api.deepinfra.com/v1/openai" } as NodeJS.ProcessEnv),
  "openai",
  "a base URL is the only reason to set one, so infer the protocol from it",
);
assert.equal(
  resolveProvider({ OPENAI_BASE_URL: "http://localhost:1234/v1" } as NodeJS.ProcessEnv),
  "openai",
);
assert.equal(
  resolveProvider({ GURU_PROVIDER: "anthropic", OPENAI_BASE_URL: "x" } as NodeJS.ProcessEnv),
  "anthropic",
  "explicit GURU_PROVIDER beats inference",
);

// --- body translation ----------------------------------------------------

// A plain string system prompt becomes a system message.
{
  const body = toOpenAiBody({
    model: "m",
    max_tokens: 10,
    system: "be helpful",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(body.messages, [
    { role: "system", content: "be helpful" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(body.max_tokens, 10);
}

// System BLOCKS (what contextualize() sends, carrying cache_control) flatten to
// one string, and cache_control is dropped rather than leaking into the body.
{
  const body = toOpenAiBody({
    model: "m",
    max_tokens: 150,
    system: [
      { type: "text", text: "<book>…</book>", cache_control: { type: "ephemeral" } },
      { type: "text", text: "second block" },
    ],
    messages: [{ role: "user", content: "chunk" }],
  } as any);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, "<book>…</book>\n\nsecond block");
  assert(!JSON.stringify(body).includes("cache_control"), "cache_control must not reach OpenAI");
}

// No system at all: no system message, not an empty one (some endpoints 400 on it).
{
  const body = toOpenAiBody({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "q" }] });
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
}

// The ask() retry loop sends assistant turns back; roles must survive.
{
  const body = toOpenAiBody({
    model: "m",
    max_tokens: 5,
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
      { role: "user", content: "fix it" },
    ],
  });
  assert.deepEqual(body.messages.map((m) => m.role), ["user", "assistant", "user"]);
}

// --- one real round trip -------------------------------------------------

const seen: any[] = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
  });
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;

process.env.GURU_PROVIDER = "openai";
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1/`; // trailing slash on purpose
process.env.OPENAI_API_KEY = "test-key";

// No cache-busting import needed: config() reads env on first use, so clearing
// the cache is enough for the env set above to take effect.
_resetLlmConfig();
const out = await expandQuery("what is the way?");

assert(out.includes("pong"), "the model's text comes back to the caller");
assert.equal(seen.length, 1);
assert.equal(seen[0].url, "/v1/chat/completions", "trailing slash must not double up");
assert.equal(seen[0].auth, "Bearer test-key");
assert.equal(seen[0].body.messages.at(-1).role, "user");

server.close();
console.error("openai-compatible tests ok");
