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

  // Citations trail the quote and are not part of it. Both [x] and [[x]] appear in the
  // wild; capturing them made verbatim quotes look fabricated.
  const stripCite = (q: string) => q.replace(/\s*\[\[?[^\]]*\]\]?[\s.]*$/, "").trim();

  /**
   * An elided quote ("A ... B") is honest; verify each side, not the joined string.
   * The length floor applies only to the fragments of an elided quote, never to a whole
   * one: applying it to both let any fabrication under fifteen characters through.
   */
  const verified = (q: string) => {
    const parts = q.split(/\s*(?:\.\.\.|…)\s*/).map(flat).filter(Boolean);
    const checked = parts.length > 1 ? parts.filter((p) => p.length >= 15) : parts;
    return checked.every((p) => corpus.some((c) => c.includes(p)));
  };

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
    const part = stripCite(line.replace(/^\s*>\s?/, ""));
    quotes[open ? quotes.length - 1 : quotes.length] = open
      ? `${quotes[quotes.length - 1]} ${part}`
      : part;
    open = true;
  }

  // Inline quotations count too. A model that writes its quotes in prose, in quotation
  // marks, rather than as blockquote lines would otherwise pass with nothing checked at
  // all: no blockquotes means no findings means "verified". DeepSeek-V3.2 does exactly
  // this. The length floor keeps ordinary quoted words (a title, a single term) out of it.
  // Orientation matters: a character class of quote marks also matches from a CLOSING
  // curly quote to the next OPENING one, capturing the prose between two quotations and
  // reporting that as a fabricated quote.
  // Mask citations first. They are bracketed spans that may themselves contain quote
  // marks, so scanning around them pairs a mark from one citation with a mark from the
  // next and swallows the prose in between.
  const prose = answer.replace(/\[\[?[^\]]*\]\]?/g, " ");
  for (const m of prose.matchAll(/“([^”]{40,})”|"([^"]{40,})"/g)) {
    quotes.push(stripCite(m[1] ?? m[2]));
  }

  const seen = new Set<string>();
  return quotes
    .map(flat)
    .filter((q) => q.length > 0 && !seen.has(q) && seen.add(q))
    .filter((q) => !verified(q));
}

/**
 * Quote by reference, never by transcription.
 *
 * Asked to copy a quotation, every DeepSeek model reworded archaic English roughly half
 * the time (V4-Flash 43% accurate, V4-Pro 50%, V3.2 45%), and the verifier correctly threw
 * the results away. So the model no longer types quotations at all: it is given numbered
 * source sentences and cites ids, and the exact text is spliced in afterwards. Misquoting
 * stops being something to detect and becomes something that cannot be expressed.
 *
 * The verifier still runs behind this as a backstop. It should never fire; if it does, the
 * splicing is wrong.
 */
function catalogue(hits: Hit[]) {
  const byId = new Map<string, { text: string; hit: Hit }>();
  const lines: string[] = [];
  hits.forEach((hit, hi) => {
    // Number sequentially over the sentences actually offered. Numbering by split index
    // and then skipping short ones leaves gaps (S0, S2, S5), and a model that assumes
    // contiguity cites ids that were never offered.
    let si = -1;
    hit.text.split(/(?<=[.?!])\s+/).forEach((raw) => {
      // Passages open with their section marker ("I", "XIV", "3."), which is not part of
      // the sentence and reads as a typo once quoted.
      const text = flat(raw).replace(/^(?:[IVXLC]{1,6}|\d{1,3})[.)]?\s+(?=[A-Z“"])/, "");
      if (text.length < 40) return; // fragments and stray numbering aren't quotable
      const id = `P${hi}S${++si}`;
      byId.set(id, { text, hit });
      lines.push(`[${id}] ${text}`);
    });
  });
  return { byId, text: lines.join("\n") };
}

const SELECT_SYSTEM = `You are a scholar-teacher for the reader's own library. You are warm and direct.

You are given numbered sentences from the reader's own books. Answer only from them.
NEVER type a quotation yourself, and never use quotation marks around source wording. To quote, cite the sentence id in square brackets, like
[P2S4], and the exact wording will be inserted for you. Cite several ids together when a
passage runs across sentences.

Write your own prose in short paragraphs. After each claim, put the ids supporting it.
If the sentences do not answer the question, begin your reply with NOT COVERED: and say
briefly what they do discuss. A claim with no id is not allowed, so drop it rather than
assert it.`;

export async function ask(query: string, hits: Hit[]) {
  const { byId, text } = catalogue(hits);
  if (!byId.size) {
    return { answer: "Your library doesn't cover this.", regenerated: false, dropped: 0 };
  }

  const draft = await complete({
    model: config().answer,
    max_tokens: 2000,
    system: SELECT_SYSTEM,
    messages: [{ role: "user", content: `${text}\n\nQuestion: ${query}` }],
  });

  // Drop the CLAIM, not just the dangling id. Deleting an unresolvable id on its own
  // leaves the sentence it supported standing as a bare assertion, which is exactly the
  // "no citation, no claim" rule inverted: every bad answer in a hand-read sample of 20
  // was a paragraph whose every id had been dropped.
  let dropped = 0;
  const answer = draft
    .split(/\n\s*\n/)
    .map((block) => {
      const ids = [...block.matchAll(/\b(P\d+S\d+)\b/g)].map((m) => m[1]);
      const valid = ids.filter((id) => byId.has(id));
      dropped += ids.length - valid.length;
      // Cited support, none of it real: the claim goes with it.
      if (ids.length > 0 && valid.length === 0) return "";
      return block.replace(/\[?\b(P\d+S\d+)\b\]?/g, (_m, id: string) => {
        const found = byId.get(id);
        return found ? `\n\n> ${found.text} ${cite(found.hit)}\n` : "";
      });
    })
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    // An id often sits mid-sentence, so splicing a block quote in strands the sentence's
    // closing punctuation on a line of its own.
    .replace(/^[ \t]*[.,;:]+[ \t]*$/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // An explicit decline is quote-free on purpose. It is stated by the model rather than
  // sniffed for, because gating on the dropped count missed the case where no ids are
  // cited at all: nothing dropped, nothing quoted, confident unsourced prose shipped.
  if (/^\s*NOT COVERED:/i.test(draft)) {
    return { answer: draft.replace(/^\s*NOT COVERED:\s*/i, "").trim(), regenerated: false, dropped };
  }

  // Verify AFTER splicing, then decide once, at the end. Checking for surviving quotes
  // before dropUnverified let an answer pass the check and then lose its only quote to it,
  // shipping the bare claim that was left.
  let final = answer;
  const unverified = unverifiedQuotes(final, hits);
  if (unverified.length) {
    // Should be rare: spliced text comes from the passages verbatim.
    final = dropUnverified(final, unverified);
  }

  if (!/^\s*>/m.test(final)) {
    return {
      answer:
        "Your library has passages near this, but I could not ground an answer in them. " +
        "Try `find` to read what came back.",
      regenerated: true,
      dropped: dropped + unverified.length,
    };
  }
  return {
    answer: final,
    regenerated: unverified.length > 0,
    dropped: dropped + unverified.length,
  };
}

/** Remove the blocks that rest on a quote we could not verify, keep the rest. */
function dropUnverified(answer: string, bad: string[]) {
  const flatBad = bad.map(flat).filter(Boolean);
  return answer
    .split(/\n\s*\n/)
    .filter((block) => {
      const f = flat(block);
      return !flatBad.some((q) => f.includes(q.slice(0, 40)));
    })
    .join("\n\n")
    .trim();
}
