// Exercises the LLM layer against a stub API: request shapes, the rerank parse,
// and the ask -> verify -> regenerate loop. No key, no tokens. Run: node test/llm.test.ts
import { createServer } from "node:http";
import assert from "node:assert";
import type { Hit } from "../src/store.ts";

const seen: any[] = [];
let replies: string[] = [];

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push(JSON.parse(body));
    // Anthropic SSE — the client always streams (see complete() in src/llm.ts).
    const text = replies.shift() ?? "";
    res.setHeader("content-type", "text/event-stream");
    const send = (type: string, data: unknown) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
    send("message_start", {
      message: { id: "msg_stub", type: "message", role: "assistant", model: "stub",
                 content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
    });
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    send("message_stop", {});
    res.end();
  });
});

await new Promise<void>((r) => server.listen(0, r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.ANTHROPIC_API_KEY = "stub";

const { ask, contextualize, rerank } = await import("../src/llm.ts");

const hit = (id: number, text: string): Hit => ({
  id, chunk_id: id, text, page_start: "1", page_end: "1",
  title: "Tao Te Ching", author: "Laozi", paginated: 1, score: 1,
});

// --- contextualize: the book is the cached prefix; context is prepended to the chunk
replies = ["Chapter one, on the unnameable Tao.", "Chapter two, on opposites."];
const chunks = [
  { chunk_id: 0, text: "The Tao that can be trodden", page_start: 1, page_end: 1 },
  { chunk_id: 1, text: "All in the world know the beauty", page_start: 1, page_end: 1 },
];
const contexts = await contextualize({ title: "Tao Te Ching", author: "Laozi" }, chunks);
assert.equal(contexts[0], "Chapter one, on the unnameable Tao.\n\nThe Tao that can be trodden");
assert.equal(seen[0].system[0].cache_control.type, "ephemeral");
assert(seen[0].system[0].text.includes("All in the world know"), "full book must be cached");
assert.equal(seen.length, 2, "one call per chunk");

// --- rerank: reorders by the returned indices, capped at k
seen.length = 0;
replies = ["2, 0"];
const hits = [hit(10, "a"), hit(11, "b"), hit(12, "c")];
assert.deepEqual((await rerank("q", hits, 5)).map((h) => h.id), [12, 10]);
assert.equal(seen[0].stream, true, "must stream: routers return OpenAI JSON otherwise");

// A rerank that drops everything must not silently empty the results.
replies = ["none of them are relevant"];
assert.equal((await rerank("q", hits, 5)).length, 3);

// --- ask: a fabricated quote is caught, named back to the model, and the retry wins
seen.length = 0;
const passage = hit(1, "The Tao that can be trodden is not the enduring and unchanging Tao.");
replies = [
  "The Tao resists naming.\n\n> Be water, my friend. [Tao Te Ching, Laozi, p. 1]",
  "The Tao resists naming.\n\n> The Tao that can be trodden\n> is not the enduring and unchanging Tao. [Tao Te Ching, Laozi, p. 1]",
];
const { answer, regenerated } = await ask("what is the Tao?", [passage]);
assert(regenerated, "should have regenerated");
assert(answer.includes("enduring and unchanging"));
assert.equal(seen.length, 2);
assert(
  JSON.stringify(seen[1].messages).includes("Be water, my friend."),
  "the retry must name the rejected quote",
);

// A faithful quote the model wrapped in quotation marks must NOT be rejected:
// models write `> "..."` constantly, and those marks are not in the source text.
seen.length = 0;
replies = ['> "The Tao that can be trodden is not the enduring and unchanging Tao." [x]'];
assert.equal((await ask("q", [passage])).regenerated, false, "wrapped quotes are not fabrications");

// Two clean drafts in a row would be a false rejection.
seen.length = 0;
replies = ["> The Tao that can be trodden is not the enduring and unchanging Tao. [x]"];
assert.equal((await ask("q", [passage])).regenerated, false);

server.close();
console.error("llm stub tests ok");
