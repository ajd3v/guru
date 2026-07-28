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

const { ask, contextualize, expandQuery, rerank, unverifiedQuotes } = await import("../src/llm.ts");

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

// --- HyDE: the hypothetical answer is searched alongside the question, not instead of it,
// so exact phrasings still match on BM25.
seen.length = 0;
replies = ["The Tao that can be trodden is not the enduring Tao."];
const expanded = await expandQuery("can the eternal way be put into words?");
assert(expanded.includes("can the eternal way be put into words?"), "must keep the question");
assert(expanded.includes("trodden"), "must include the hypothetical answer");

// --- rerank: reorders by the returned indices, capped at k
seen.length = 0;
replies = ["2, 0"];
const hits = [hit(10, "a"), hit(11, "b"), hit(12, "c")];
assert.deepEqual((await rerank("q", hits, 5)).map((h) => h.id), [12, 10]);
assert.equal(seen[0].stream, true, "must stream: routers return OpenAI JSON otherwise");

// A rerank that drops everything must not silently empty the results.
replies = ["none of them are relevant"];
assert.equal((await rerank("q", hits, 5)).length, 3);

// --- ask: the model cites sentence ids and never types quotations. The exact wording is
// spliced in from the passage, so a misquote is not expressible rather than merely detected.
seen.length = 0;
const passage = hit(1, "The Tao that can be trodden is not the enduring and unchanging Tao. The name that can be named is not the enduring and unchanging name.");
replies = ["Naming has limits. [P0S0]"];
const sel = await ask("what is the Tao?", [passage]);
assert(sel.answer.includes("The Tao that can be trodden"), "verbatim text is spliced in");
assert(sel.answer.includes("[Tao Te Ching, Laozi, p. 1]"), "citation follows the quote");
assert.equal(sel.dropped, 0);
assert(
  JSON.stringify(seen[0].messages).includes("[P0S0]"),
  "the model must be offered numbered sentences",
);

// A citation may contain quote marks (EPUB locators did). Scanning prose around them
// paired a mark from one citation with a mark from the next and swallowed everything
// between, reporting the answer's own body as a fabricated quotation.
assert.deepEqual(
  unverifiedQuotes(
    'Text. [Book, Author, "CHAPTER I", para. 1] More text. [Book, Author, "CHAPTER II", para. 2]',
    [passage],
  ),
  [],
  "citations are not scanned as quotations",
);

// A claim whose every citation was invented must go with them. Deleting the ids alone
// left a confident assertion with nothing behind it.
seen.length = 0;
replies = ["Supported claim. [P0S0]\n\nUnsupported claim. [P9S9]"];
const partial = await ask("q", [passage]);
assert(partial.answer.includes("Supported claim"), "supported claim survives");
assert(!partial.answer.includes("Unsupported claim"), "claim with only invented ids is dropped");

// If nothing at all survives, say so rather than shipping unsourced prose.
seen.length = 0;
replies = ["Confident but unsupported prose with no ids anywhere. [P9S9]"];
const nothing = await ask("q", [passage]);
assert(/could not ground/.test(nothing.answer), "unsupported answer is replaced, not shipped");

// The same shape with no ids at all: nothing is dropped, so a dropped-count gate missed it.
seen.length = 0;
replies = ["Confident prose that cites nothing whatsoever."];
const noIds = await ask("q", [passage]);
assert(/could not ground/.test(noIds.answer), "unsourced prose is caught even when nothing was dropped");

// An explicit decline is quote-free on purpose and must survive, with the marker stripped.
seen.length = 0;
replies = ["NOT COVERED: these sentences discuss water, not the question asked."];
const declined = await ask("q", [passage]);
assert(/discuss water/.test(declined.answer), "decline text survives");
assert(!/NOT COVERED/.test(declined.answer), "marker is stripped");

// An invented id cannot become a quotation: it is dropped and counted.
seen.length = 0;
replies = ["Confident nonsense. [P9S9]"];
const bogus = await ask("q", [passage]);
assert.equal(bogus.dropped, 1, "unknown id is dropped");
assert(!bogus.answer.includes("P9S9"), "no broken marker is shown");

server.close();
console.error("llm stub tests ok");
