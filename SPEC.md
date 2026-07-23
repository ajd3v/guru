# guru — Spec (v2, post-grill)

**Positioning:** a study companion — a scholar-teacher for *your* multi-tradition spiritual library that **never misquotes**. Every substantive claim is a verbatim quote cited with **title, author, page number**. No citation → no claim.

**Why this lane:** faith apps (Bible Chat 30M+ downloads, Hallow) are locked to one canon and persona-first; NotebookLM-class tools have citations but no soul, no tradition-awareness. Nobody does *your own* multi-tradition library + teacher persona + verified verbatim quotes + cross-tradition synthesis. Moats: (1) "guru never fabricates a quote" as a trust brand, (2) cross-tradition synthesis, (3) curated public-domain starter library.

## Product

- **Web SaaS** at launch: upload library, chat, subscribe.
- **MCP fast-follow** (weeks after launch): remote MCP endpoint (OAuth + streamable HTTP) on the same backend — paid-tier perk, "add your guru to the assistant" marketing hook.
- **Starter library**: curated public-domain corpus every user gets day one (Bhagavad Gita, Tao Te Ching, Dhammapada, Meister Eckhart, William James, Cloud of Unknowing…). Solves empty-state onboarding and gives a zero-copyright demo corpus.

## Copyright posture (hybrid)

- PD starter corpus: fully public, shareable.
- User uploads: private per-user, never shared or pooled across users, no public excerpts. ToS: user warrants rights. DMCA policy + takedown process. Standard Dropbox/NotebookLM posture.

## Core loop

```
question → contextual-hybrid retrieval → rerank → teacher answer with blockquoted verbatim citations [Title, Author, p. N] → quote verifier
```

## Ingestion

- PDFs/EPUBs. **Page fidelity is the whole game**: pymupdf per-page extraction; EPUBs have no real pages → cite chapter + paragraph and say so honestly.
- Chunks ~500 tokens with overlap, metadata `{title, author, page_start, page_end, chunk_id}`. Title/author from metadata, `Author - Title.pdf` convention, or one LLM pass over first pages.
- **Contextual retrieval** (Anthropic-style): at ingest, an LLM (Haiku-tier, prompt-cached against the full doc) prepends situating context to each chunk before embedding — ~49% fewer retrieval failures. One-time cost ≈ $1–3 per 400-page book with caching.
- Ingest runs in a **sandboxed worker** (PDF parsers are an RCE surface), size-capped, virus-scanned.

## Retrieval (launch stack — SOTA where it pays)

1. Hybrid: BM25 (SQLite FTS5) + vector (sqlite-vec), reciprocal-rank fusion, top ~20
2. Cross-encoder / LLM rerank → top ~5
3. **Verbatim-quote verifier**: every blockquote in the answer must be a substring of a retrieved chunk; failures are dropped and the answer regenerated. ~10 lines; it is the brand.

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

1. Ingest with page-accurate metadata + contextual enrichment → query a known quote, get the right page.
2. Chat with cited answers, verifier passing. CLI/API first.
3. Web SaaS: auth, billing, upload, starter library. **Launch.**
4. MCP endpoint fast-follow (paid perk).
5. v2: concept knowledge graph → cross-tradition synthesis as the headline feature.

## Non-goals (launch)

KG (v2), ColBERT, mobile apps, devotional/practice features (different lane), fine-tuning, SOC2, teams.
