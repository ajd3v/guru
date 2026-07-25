import Anthropic from "@anthropic-ai/sdk";
import type { Chunk, Hit } from "./store.ts";
import { cite } from "./store.ts";

// Overridable so the pipeline can run against a local Anthropic-compatible router
// (ANTHROPIC_BASE_URL) whose upstreams aren't Anthropic and don't answer to claude-* ids.
const PIPELINE = process.env.GURU_PIPELINE_MODEL ?? "claude-haiku-4-5"; // contextualize, rerank
const ANSWER = process.env.GURU_ANSWER_MODEL ?? "claude-sonnet-5";
const CONCURRENCY = 8;

let client: Anthropic;
// A local router usually wants no key; the SDK refuses to construct without one.
const anthropic = () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "local" }));

/**
 * Always stream. Local Anthropic-compatible routers commonly return OpenAI-shaped JSON
 * to a non-streaming request but correct Anthropic SSE to a streaming one, and the spec
 * wants streamed answers anyway.
 */
async function complete(params: Omit<Anthropic.MessageStreamParams, "stream">) {
  const message = await anthropic().messages.stream(params).finalMessage();
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

async function pooled<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  // The first call runs alone so it writes the prompt cache the rest read. Fanning
  // out immediately would make all 8 pay the write: a cache entry is only readable
  // once the first response has started.
  const out: R[] = items.length ? [await fn(items[0])] : [];
  for (let i = 1; i < items.length; i += CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + CONCURRENCY).map(fn))));
  }
  return out;
}

/**
 * Anthropic-style contextual retrieval: prepend a situating sentence to each chunk
 * before embedding. The whole book is the cached prefix, so we pay for it once.
 * Cache minimum is 4096 tokens on Haiku — short books just won't hit the cache.
 */
export async function contextualize(book: { title: string; author: string }, chunks: Chunk[]) {
  const doc = chunks.map((c) => c.text).join("\n\n");
  return pooled(chunks, async (chunk) => {
    const context = await complete({
      model: PIPELINE,
      max_tokens: 150,
      system: [
        {
          type: "text",
          text: `<book title="${book.title}" author="${book.author}">\n${doc}\n</book>`,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content:
            `Here is a chunk from that book:\n\n<chunk>\n${chunk.text}\n</chunk>\n\n` +
            "Write one or two sentences situating this chunk within the book: which section " +
            "or teaching it belongs to, who or what it discusses, and the terms a reader might " +
            "search for to find it. Answer with the context only, nothing else.",
        },
      ],
    });
    return `${context.trim()}\n\n${chunk.text}`;
  });
}

/** Step 2 of the retrieval stack: an LLM reorders the fused candidates. */
export async function rerank(query: string, hits: Hit[], k = 5): Promise<Hit[]> {
  if (hits.length <= 1) return hits;
  const candidates = hits
    .map((h, i) => `[${i}] ${cite(h)}\n${h.text.slice(0, 700)}`)
    .join("\n\n---\n\n");

  // ponytail: numbers scraped from prose, not a JSON schema — structured outputs don't
  // survive a translating router. Swap back to output_config if this runs on Anthropic direct.
  const reply = await complete({
    model: PIPELINE,
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content:
          `Question: ${query}\n\n${candidates}\n\n` +
          `Rank the candidates that actually help answer the question, best first. ` +
          `Judge by meaning, not shared wording: passages from different translations or ` +
          `traditions can say the same thing in different words. Drop the ones that don't help.\n` +
          `Reply with at most ${k} candidate numbers, comma-separated, and nothing else.`,
      },
    ],
  });

  const seen = new Set<number>();
  const picked = [...reply.matchAll(/\d+/g)]
    .map((m) => Number(m[0]))
    .filter((i) => hits[i] && !seen.has(i) && seen.add(i))
    .slice(0, k)
    .map((i) => hits[i]);
  return picked.length ? picked : hits.slice(0, k); // a useless rerank must not empty the results
}

const SYSTEM = `You are a scholar-teacher for the reader's own library. You are warm, direct, and
never invent a quote.

Answer only from the passages given. If they do not cover the question, say so plainly.
Support every substantive claim with a verbatim quote from the passages, as a blockquote line
starting with "> ", immediately followed by its citation in square brackets exactly as given.
Copy quoted text character for character. If you cannot quote it, do not claim it.`;

/**
 * Whitespace-insensitive, and blind to wrapping quotation marks: models routinely write
 * `> "…"` around a passage they copied faithfully, and those marks are not in the source.
 */
const flat = (s: string) =>
  s.replace(/\s+/g, " ").trim().replace(/^["“”'‘’«»]+|["“”'‘’«»]+$/g, "").trim();

/** The brand: a blockquote that is not a substring of a retrieved passage did not come from the library. */
export function unverifiedQuotes(answer: string, hits: Hit[]) {
  const corpus = hits.map((h) => flat(h.text));
  const quotes: string[] = [];
  let open = false;
  for (const line of answer.split("\n")) {
    const isQuote = line.trimStart().startsWith(">");
    if (!isQuote) {
      open = false;
      continue;
    }
    // Consecutive "> " lines are one quote: checking them separately would let a
    // fabrication through whenever each fragment happens to appear on its own.
    const part = line.replace(/^\s*>\s?/, "").replace(/\[[^\]]*\]\s*$/, "");
    quotes[open ? quotes.length - 1 : quotes.length] = open
      ? `${quotes[quotes.length - 1]} ${part}`
      : part;
    open = true;
  }
  return quotes
    .map(flat)
    .filter((q) => q.length > 0 && !corpus.some((c) => c.includes(q)));
}

/** Ask, verify, and regenerate once with the failures named. Returns the verified answer. */
export async function ask(query: string, hits: Hit[]) {
  const passages = hits
    .map((h) => `<passage cite="${cite(h)}">\n${h.text}\n</passage>`)
    .join("\n\n");

  let messages: Anthropic.MessageParam[] = [
    { role: "user", content: `<passages>\n${passages}\n</passages>\n\nQuestion: ${query}` },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await complete({ model: ANSWER, max_tokens: 2000, system: SYSTEM, messages });
    const bad = unverifiedQuotes(answer, hits);
    if (!bad.length) return { answer, regenerated: attempt > 0 };

    messages = [
      ...messages,
      { role: "assistant", content: answer },
      {
        role: "user",
        content:
          `These quotes do not appear verbatim in the passages:\n` +
          bad.map((q) => `- "${q}"`).join("\n") +
          `\n\nRewrite the answer. Quote only text you can copy exactly from a passage, or drop the claim.`,
      },
    ];
  }
  throw new Error("could not produce an answer with verifiable quotes");
}
