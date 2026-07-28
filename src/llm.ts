import Anthropic from "@anthropic-ai/sdk";
import type { Chunk, Hit } from "./store.ts";
import { cite } from "./store.ts";

/**
 * Two wire protocols, one call site.
 *
 * The pipeline is written against Anthropic's Messages shape. Plenty of useful
 * endpoints (DeepInfra, Together, vLLM, LM Studio, OpenRouter) only speak OpenAI
 * chat/completions, so `complete()` translates on the way out rather than making
 * every caller care. Selection is by env: set GURU_PROVIDER, or just set a base
 * URL and the right protocol is inferred.
 */
export type Provider = "anthropic" | "openai";

export function resolveProvider(env = process.env): Provider {
  const explicit = env.GURU_PROVIDER?.toLowerCase();
  if (explicit === "openai" || explicit === "anthropic") return explicit;
  // Inferred: an OpenAI-compatible base URL is the only reason to set one.
  if (env.OPENAI_BASE_URL || env.DEEPINFRA_BASE_URL) return "openai";
  return "anthropic";
}

// Model ids are protocol-specific: an OpenAI-compatible endpoint will not answer
// to claude-* ids, so the defaults differ. Override either with GURU_*_MODEL.
const DEFAULTS = {
  anthropic: { pipeline: "claude-haiku-4-5", answer: "claude-sonnet-5" },
  openai: { pipeline: "deepseek-ai/DeepSeek-V4-Flash", answer: "deepseek-ai/DeepSeek-V4-Flash" },
} as const;

/**
 * Resolved on FIRST USE, not at module scope. ESM hoists imports, so anything
 * that loads a .env from an entry point runs after this module is evaluated;
 * reading env at module scope would silently miss it and pick the wrong provider.
 */
let cfg: { provider: Provider; pipeline: string; answer: string } | undefined;
function config() {
  if (cfg === undefined) {
    const provider = resolveProvider();
    cfg = {
      provider,
      pipeline: process.env.GURU_PIPELINE_MODEL ?? DEFAULTS[provider].pipeline, // contextualize, rerank
      answer: process.env.GURU_ANSWER_MODEL ?? DEFAULTS[provider].answer,
    };
  }
  return cfg;
}

/** Test hook: forget the cached provider/model choice. */
export function _resetLlmConfig() {
  cfg = undefined;
  client = undefined as unknown as Anthropic;
}

const CONCURRENCY = 8;

let client: Anthropic;
// A local router usually wants no key; the SDK refuses to construct without one.
const anthropic = () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "local" }));

type CompleteParams = Omit<Anthropic.MessageStreamParams, "stream">;

/**
 * Anthropic Messages params -> OpenAI chat/completions body.
 *
 * Pure and exported so the shape is testable without a network call. Two things
 * do not survive the trip:
 *   - `system` may be blocks; OpenAI wants one string, so blocks are flattened.
 *   - `cache_control` has no equivalent. OpenAI-compatible providers cache stable
 *     prefixes automatically, so this is dropped rather than emulated. Cache HITS
 *     still happen, we just cannot pin the breakpoint.
 */
export function toOpenAiBody(params: CompleteParams) {
  const systemText =
    typeof params.system === "string"
      ? params.system
      : (params.system ?? [])
          .map((b) => (typeof b === "string" ? b : b.type === "text" ? b.text : ""))
          .join("\n\n");

  const messages = [
    ...(systemText ? [{ role: "system" as const, content: systemText }] : []),
    ...params.messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content
          : m.content
              .map((b) => (b.type === "text" ? b.text : ""))
              .join(""),
    })),
  ];

  return { model: params.model, max_tokens: params.max_tokens, messages };
}

function openAiBase(env = process.env) {
  const base = env.OPENAI_BASE_URL ?? env.DEEPINFRA_BASE_URL;
  if (!base) throw new Error("GURU_PROVIDER=openai needs OPENAI_BASE_URL (or DEEPINFRA_BASE_URL)");
  return base.replace(/\/$/, "");
}

/** OpenAI-compatible path. Plain fetch: chat/completions is small enough that a
 *  second SDK would be more surface than the ~20 lines it replaces. */
async function completeOpenAi(params: CompleteParams): Promise<string> {
  const key = process.env.OPENAI_API_KEY ?? process.env.DEEPINFRA_API_KEY ?? "local";
  const res = await fetch(`${openAiBase()}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(toOpenAiBody(params)),
  });
  if (!res.ok) {
    // Include the body: these endpoints put the real reason (bad model id, quota)
    // in it, and a bare status turns a 5-second fix into a debugging session.
    throw new Error(`openai-compatible ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}

/**
 * Anthropic path always streams. Local Anthropic-compatible routers commonly return
 * OpenAI-shaped JSON to a non-streaming request but correct Anthropic SSE to a
 * streaming one, and the spec wants streamed answers anyway.
 */
async function complete(params: CompleteParams) {
  if (config().provider === "openai") return completeOpenAi(params);
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
      model: config().pipeline,
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

/**
 * HyDE: search with a hypothetical answer instead of the bare question.
 *
 * A question and the passage that answers it often share almost no vocabulary — "can the
 * eternal way be put into words?" against "The Tao that can be trodden is not the enduring
 * and unchanging Tao." No embedder or chunk size fixed that; writing the answer in the
 * source's own register is what closes the gap. The question is kept alongside so exact
 * phrasings still match on BM25.
 */
export async function expandQuery(query: string) {
  const hypothetical = await complete({
    model: config().pipeline,
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content:
          `Write two or three sentences as they might appear in a classic work of ` +
          `philosophy or scripture, answering: ${query}\n\n` +
          `Use the vocabulary and register such a text would use, not modern paraphrase. ` +
          `Do not hedge or explain. Output only the passage.`,
      },
    ],
  });
  return `${query}\n${hypothetical}`;
}

/**
 * How many candidates one rerank call may judge. Measured on 60 cases: at 20 candidates
 * the reranker lost 3 of what search found, at 60 it lost 13, and the extra recall from
 * depth cancelled out exactly. Snippet length was not the cause (700 chars scored the same
 * as 350). The limit is the reranker's discrimination, so deep candidate sets are judged in
 * batches of this size and the survivors ranked against each other.
 */
const RERANK_BATCH = 20;

/**
 * A rerank that returns nothing parseable degrades to the unranked order, which is correct
 * behaviour but indistinguishable from a reranker that simply ranked badly. A rate-limited
 * or truncating model therefore looks like a quality result. Count it so the eval can say
 * whether a number reflects the pipeline or a dead upstream.
 */
export const stats = { rerankCalls: 0, rerankFallbacks: 0 };

/** Step 2 of the retrieval stack: an LLM reorders the fused candidates. */
export async function rerank(query: string, hits: Hit[], k = 5): Promise<Hit[]> {
  if (hits.length <= 1) return hits;

  if (hits.length > RERANK_BATCH) {
    const batches: Hit[][] = [];
    for (let i = 0; i < hits.length; i += RERANK_BATCH) {
      batches.push(hits.slice(i, i + RERANK_BATCH));
    }
    const survivors = (await Promise.all(batches.map((b) => rerankOne(query, b, k)))).flat();
    return survivors.length > k ? rerankOne(query, survivors, k) : survivors;
  }
  return rerankOne(query, hits, k);
}

async function rerankOne(query: string, hits: Hit[], k: number): Promise<Hit[]> {
  if (hits.length <= 1) return hits;
  // Snippet length trades against candidate count for a fixed prompt budget.
  const snippet = Number(process.env.GURU_SNIPPET ?? 700);
  const candidates = hits
    .map((h, i) => `[${i}] ${cite(h)}\n${h.text.slice(0, snippet)}`)
    .join("\n\n---\n\n");

  // ponytail: numbers scraped from prose, not a JSON schema — structured outputs don't
  // survive a translating router. Swap back to output_config if this runs on Anthropic direct.
  const reply = await complete({
    model: config().pipeline,
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

  stats.rerankCalls++;
  const seen = new Set<number>();
  const picked = [...reply.matchAll(/\d+/g)]
    .map((m) => Number(m[0]))
    .filter((i) => hits[i] && !seen.has(i) && seen.add(i))
    .slice(0, k)
    .map((i) => hits[i]);
  if (!picked.length) stats.rerankFallbacks++; // upstream said nothing usable
  return picked.length ? picked : hits.slice(0, k); // a useless rerank must not empty the results
}

const SYSTEM = `You are a scholar-teacher for the reader's own library. You are warm, direct, and
never invent a quote.

Answer only from the passages given. If they do not cover the question, say so plainly.
Support every substantive claim with a verbatim quote from the passages, as a blockquote line
starting with "> ", immediately followed by its citation in square brackets exactly as given.
Copy quoted text character for character. If you cannot quote it, do not claim it.

Write each citation as plain text in one pair of square brackets, copied exactly from the
passage's cite attribute. Never turn a citation into a markdown link or add a URL.`;

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
    const answer = await complete({ model: config().answer, max_tokens: 2000, system: SYSTEM, messages });
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
