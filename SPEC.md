# guru — Spec (v2, post-grill)

**Positioning:** a study companion — a scholar-teacher for *your* multi-tradition spiritual library that **never misquotes**. Every substantive claim is a verbatim quote cited with **title, author, page number**. No citation → no claim.

**Why this lane:** faith apps (Bible Chat 30M+ downloads, Hallow) are locked to one canon and persona-first; NotebookLM-class tools have citations but no soul, no tradition-awareness. Nobody does *your own* multi-tradition library + teacher persona + verified verbatim quotes + cross-tradition synthesis. Moats: (1) "guru never fabricates a quote" as a trust brand, (2) cross-tradition synthesis, (3) curated public-domain starter library.

## Product

- **Web SaaS** at launch: upload library, chat, subscribe.
- **MCP fast-follow** (weeks after launch): remote MCP endpoint (OAuth + streamable HTTP) on the same backend — paid-tier perk, "add your guru to the assistant" marketing hook.
- **Starter library**: curated public-domain corpus every user gets day one. Fourteen books spanning scripture and secular spiritual writing: Tao Te Ching, Bhagavad Gita, Dhammapada, Imitation of Christ, William James, Marcus Aurelius, Epictetus, Boethius, Emerson, Thoreau, Whitman, Nietzsche, Gibran, James Allen. Solves empty-state onboarding, gives a zero-copyright demo corpus, and is the eval corpus (see `starter/library.json`).

## Copyright posture (hybrid)

- PD starter corpus: fully public, shareable.
- User uploads: private per-user, never shared or pooled across users, no public excerpts. ToS: user warrants rights. DMCA policy + takedown process. Standard Dropbox/NotebookLM posture.

## Core loop

```
question → hypothetical answer (HyDE) → hybrid retrieval → rerank → teacher answer with blockquoted verbatim citations [Title, Author, p. N] → quote verifier
```

## Ingestion

- PDFs/EPUBs. **Page fidelity is the whole game**: pymupdf per-page extraction; EPUBs have no real pages → cite chapter + paragraph and say so honestly.
- Chunks ~500 tokens with overlap, metadata `{title, author, page_start, page_end, chunk_id}`. Title/author from metadata, `Author - Title.pdf` convention, or one LLM pass over first pages.
- **Contextual retrieval** (Anthropic-style): at ingest, an LLM (Haiku-tier, prompt-cached against the full doc) prepends situating context to each chunk before embedding. One-time cost ≈ $1–3 per 400-page book with caching. **Deferred, not at launch.** Measured on a matched 3-book A/B (41 cases) it moved recall@20 71%→73% and recall@5 29%→34%, one and two cases respectively, inside noise, while HyDE gave +22 points for no ingest cost. It is not harmful, it is unproven, and it is the most expensive thing in the pipeline. Revisit with a Haiku contextualizer and real prompt caching, judged on the eval.
- Ingest runs in a **sandboxed worker** (PDF parsers are an RCE surface), size-capped, virus-scanned.

## Retrieval (launch stack — SOTA where it pays)

0. **HyDE**: a cheap model writes the answer the question is looking for, in the register the sources use, and that text is searched alongside the question. A reader asks "can the eternal way be put into words?"; the book says "The Tao that can be trodden is not the enduring and unchanging Tao." Almost no shared vocabulary, and this is what closes the gap.
1. Hybrid: BM25 (SQLite FTS5) + vector (sqlite-vec, local BGE-base embeddings), reciprocal-rank fusion. Fuse from ~3x depth: RRF ranks an item mediocre in both halves above one that is first in a single half, so a shallow fetch loses exact hits.
2. Cross-encoder / LLM rerank → top ~5
3. **Quotation by reference, not transcription**: the answer model is given numbered source sentences and cites ids; the exact wording is spliced in afterwards. Asked to copy quotations instead, every DeepSeek tier reworded archaic English roughly half the time (V4-Flash 43% accurate, V4-Pro 50%, V3.2 45%). Selecting ids, the cheapest tier renders 42 quotes across four questions with **zero** unverifiable. Misquoting stops being something to detect and becomes something that cannot be expressed.
4. **Every claim carries a citation or is removed.** A paragraph whose cited ids all turn out to be invented is dropped with them, and an answer left with no quote at all is replaced by an honest refusal rather than shipped as unsourced prose. Declining is stated explicitly by the model (`NOT COVERED:`) so a legitimate refusal is distinguishable from a bare assertion. Hand-read sample of 20 answers found 5 shipping unsupported claims; after this, a fresh sample of 14 gave 9 grounded, 5 honest refusals, 0 bare claims.
5. **Verbatim-quote verifier**: a backstop behind the above. Every quoted span, blockquote or inline, must be a substring of a retrieved chunk; blocks resting on one that isn't are dropped and reported. It is the brand, and it should now never fire.

**Measured, all 151 cases, DeepSeek-V4-Flash via DeepInfra, rerank fallback rate 0%:**

| stage | recall@20 | recall@5 | MRR |
|---|---|---|---|
| hybrid search alone | 42% | 23% | 0.156 |
| + 60 candidates reranked in batches of 20 | 56% | 45% | 0.375 |
| + HyDE | **73%** | **60%** | **0.505** |

Three things are settled. Reranking is the bottleneck, not search: the right chunk is
within the first 500 results for 76 of 89 failing cases. One rerank call can only
discriminate among roughly twenty candidates, so depth must be judged in batches; a single
call over sixty scores no better than one over twenty. And HyDE is worth fifteen points of
recall@5 even on top of batching, so it stays.

**Retrieval is no longer the only thing between this and launch.** 40% of questions still
miss, but the answer model now matters as much: a budget model reliably fails to copy
archaic English character for character, and the verifier correctly refuses it. On one
Stoic/devotional question DeepSeek-V3.2 produced eleven unverifiable quotes and one good
one. Model choice for the answer step is a quality decision, not a cost decision.

**The eval is part of the stack, not a nice-to-have.** Chunk size, embedder, fusion depth, and contextual retrieval are all knobs whose right setting is a measurement. A 10-case eval measured HyDE as noise and nearly got it discarded; at 90 cases it was the single biggest win. Cases are generated from the corpus and rejected when query and answer share more than a quarter of their content words, so they test meaning rather than word overlap.

**v2 (revenue-funded): concept knowledge graph.** LLM extracts (concept, relation, concept, source-chunk) triples at ingest into the same SQLite; graph hops expand retrieval before rerank. Powers cross-tradition queries ("what do Ramana and Eckhart agree on"). ColBERT/late-interaction: not planned unless quality data demands it.

## Agent

- Single agent, warm scholar-teacher persona. Answers **only** from retrieved passages; says "your library doesn't cover this" instead of hallucinating.
- Model routing: Haiku-tier for pipeline steps (contextualizing, rerank, query rewrite), Sonnet-tier for the answer. Streaming responses.
- Conversation memory: last-N messages.

## Architecture & security

- **SQLite-per-user** (sqlite-vec + FTS5): one file per user = isolation by filesystem — no `WHERE user_id` bug can leak book A to user B. Microsecond queries, trivial data export/delete.
- **Litestream** continuous replication to S3. Encryption at rest + TLS.
- Hosting: Fly.io / Hetzner / Railway-class with persistent volumes (SQLite rules out pure serverless).
- Auth: managed (Clerk/WorkOS) — never hand-rolled. Billing: Stripe.
- GDPR-shaped from day one: per-user export + delete endpoints.
- SOC2 / pen test / WAF: deferred until an institutional buyer asks.

## Pricing

~$10–15/mo subscription. Fair-use caps: ~50 books ingested, generous daily chat. Ingest is the cost spike; chat is cheap with model routing + prompt caching.

## Stack

**TypeScript core** (backend + web + MCP: one language, one deployable; reference MCP SDK) · better-sqlite3 + sqlite-vec + FTS5 + Litestream · the assistant (Sonnet answers, Haiku pipeline) · Clerk/WorkOS · Stripe · Fly.io-class host. Web UI: minimal, calm, fast (SSR or thin React — decide at build).

**Ingest sidecar: Python** (~50 lines, pymupdf + ebooklib) — PDF/EPUB in → JSON chunks with page numbers out, run by a queue worker in its sandbox. The language boundary doubles as the security boundary. Rationale: bottleneck is LLM latency, not runtime; PyMuPDF is the only irreplaceable Python dependency. Rust/Go rejected: they optimize microseconds in a pipeline dominated by seconds-long API calls, at solo-dev iteration cost; Rust reconsidered only for a profiled retrieval bottleneck or a future local/desktop build.

## Milestones

1. ~~Ingest with page-accurate metadata~~ **done**. Query a known quote, get the right page. Contextual enrichment built but deferred (see Ingestion).
2. ~~Chat with cited answers, verifier passing. CLI/API first.~~ **done**. Remaining before launch: get retrieval recall high enough that the citations are of the right passage.
3. Web SaaS: auth, billing, upload, starter library. **Launch.**
4. MCP endpoint fast-follow (paid perk).
5. v2: concept knowledge graph → cross-tradition synthesis as the headline feature.

## Non-goals (launch)

KG (v2), ColBERT, mobile apps, devotional/practice features (different lane), fine-tuning, SOC2, teams.
