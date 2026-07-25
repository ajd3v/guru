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
- **Contextual retrieval** (Anthropic-style): at ingest, an LLM (Haiku-tier, prompt-cached against the full doc) prepends situating context to each chunk before embedding. One-time cost ≈ $1–3 per 400-page book with caching. **Deferred, not at launch.** Measured on 68 cases it moved recall@20 43%→44% and recall@5 18%→21%, a 2-case difference that is inside noise, while HyDE gave +22 points for no ingest cost. It is not harmful, it is unproven, and it is the most expensive thing in the pipeline. Revisit with a Haiku contextualizer and real prompt caching, judged on the eval.
- Ingest runs in a **sandboxed worker** (PDF parsers are an RCE surface), size-capped, virus-scanned.

## Retrieval (launch stack — SOTA where it pays)

0. **HyDE**: a cheap model writes the answer the question is looking for, in the register the sources use, and that text is searched alongside the question. A reader asks "can the eternal way be put into words?"; the book says "The Tao that can be trodden is not the enduring and unchanging Tao." Almost no shared vocabulary, and this is what closes the gap.
1. Hybrid: BM25 (SQLite FTS5) + vector (sqlite-vec, local BGE-base embeddings), reciprocal-rank fusion. Fuse from ~3x depth: RRF ranks an item mediocre in both halves above one that is first in a single half, so a shallow fetch loses exact hits.
2. Cross-encoder / LLM rerank → top ~5
3. **Verbatim-quote verifier**: every blockquote in the answer must be a substring of a retrieved chunk; failures are dropped and the answer regenerated. ~10 lines; it is the brand.

**Measured, 151 cases over 14 books** (`npm run eval`, see `eval/`):

| stage | recall@20 | recall@5 |
|---|---|---|
| hybrid search alone | 42% | 23% |
| + rerank | 42% | ~37% |
| + HyDE + rerank | ~61% | ~59% |

Rerank promotes nearly everything search finds but cannot reach what it misses; HyDE raises what search finds at all. Both are needed. **Retrieval, not citation, is what stands between this and launch**: roughly 40% of questions still never surface the right passage, and when that happens the answer is built on the wrong passages or the user is told their library doesn't cover something it does.

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
