# guru, Spec (v2, post-grill)

**Positioning:** a study companion, a scholar-teacher for *your* multi-tradition spiritual library that **never misquotes**. Every substantive claim is a verbatim quote cited with **title, author, page number**. No citation → no claim.

**Why this lane:** faith apps (Bible Chat 30M+ downloads, Hallow) are locked to one canon and persona-first; NotebookLM-class tools have citations but no soul, no tradition-awareness. Nobody does *your own* multi-tradition library + teacher persona + verified verbatim quotes + cross-tradition synthesis. Moats: (1) "guru never fabricates a quote" as a trust brand, (2) cross-tradition synthesis, (3) curated public-domain starter library.

## Product

- **Web SaaS** at launch: upload library, chat, subscribe.
- **MCP fast-follow** (weeks after launch): remote MCP endpoint (OAuth + streamable HTTP) on the same backend, paid-tier perk, "plug your guru into any MCP client" marketing hook.
- **Starter library**: curated public-domain corpus every user gets day one. **123 books** (see `starter/library.json`). Scripture and secular spiritual writing across traditions (Tao Te Ching, Bhagavad Gita, Dhammapada, Analects, Upanishads, Koran, Ecclesiastes, Jataka), the ancient world (Egyptian *Book of the Dead*, Babylonian creation legends, Gilgamesh, *Popol Vuh*, both Eddas, the *Mabinogion*), Greek and Roman philosophy (Plato, Aristotle, Lucretius, Epictetus, Aurelius), Christian contemplatives (Augustine, à Kempis, Brother Lawrence, Julian of Norwich, Caussade, Dante), the Gnostics (*Pistis Sophia* and Mead), and later voices (Montaigne, Spinoza, Emerson, Thoreau, Whitman, Nietzsche, Tolstoy, Gibran, James, Allen, Drummond). Solves empty-state onboarding, gives a zero-copyright demo corpus, and is the eval corpus.

  **Nag Hammadi cannot be included.** It was discovered in 1945 and every English translation is in copyright, so the Gospel of Thomas and its companions are absent by law rather than by oversight. What is here is the whole public-domain Gnostic corpus.

  **The starter is versioned by a hash of `starter/library.json`.** It used to be keyed on the file merely existing, so growing the manifest changed nothing on any box that had already built one: no error, no warning, an old corpus for ever. The entrypoint now stamps the manifest hash beside the database and rebuilds when they differ, and stamps only after the atomic move so an interrupted build is retried rather than recorded as done.

  **Open gap: a rebuilt starter does not reach existing readers.** A library is cloned from the starter the first time a reader appears, and never again, so books added to the manifest are invisible to anyone who already has a library. Rebuilding gives them to new readers only. Fixing this needs a per-book reconciliation on boot (add the starter books a reader is missing, leave their uploads alone), which is real work and is not built. Today the only remedy is deleting a reader's file so it re-clones, which also destroys their uploads.

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
- **Contextual retrieval** (Anthropic-style): at ingest, an LLM (Haiku-tier, prompt-cached against the full doc) prepends situating context to each chunk before embedding. One-time cost ≈ $1-3 per 400-page book with caching. **Deferred, not at launch.** Measured on a matched 3-book A/B (41 cases) it moved recall@20 71%→73% and recall@5 29%→34%, one and two cases respectively, inside noise, while HyDE gave +22 points for no ingest cost. It is not harmful, it is unproven, and it is the most expensive thing in the pipeline. Revisit with a Haiku contextualizer and real prompt caching, judged on the eval.
- Ingest runs in a **sandboxed worker** (PDF parsers are an RCE surface), size-capped, virus-scanned. Built: uploads land on disk via a queue table and are parsed by `guru worker` in a separate process, size-capped during the stream rather than from `content-length`, and restricted to `.pdf`/`.epub`. **Two gaps remain before this is what the line above claims.** There is no virus scan, that needs a `clamd` in the deployment, not code. And "sandboxed" today means a process boundary and the Python/TS language split, not a container with dropped capabilities and no network; the parser still runs as the same user with the same filesystem access. Both are deployment work, and neither should be called done because the queue exists.

## Retrieval (launch stack, SOTA where it pays)

0. **HyDE**: a cheap model writes the answer the question is looking for, in the register the sources use, and that text is searched alongside the question. A reader asks "can the eternal way be put into words?"; the book says "The Tao that can be trodden is not the enduring and unchanging Tao." Almost no shared vocabulary, and this is what closes the gap.
1. Hybrid: BM25 (SQLite FTS5) + vector (sqlite-vec, local BGE-base embeddings), reciprocal-rank fusion. Fuse from ~3x depth: RRF ranks an item mediocre in both halves above one that is first in a single half, so a shallow fetch loses exact hits.
2. Cross-encoder / LLM rerank → top ~5
3. **Quotation by reference, not transcription**: the answer model is given numbered source sentences and cites ids; the exact wording is spliced in afterwards. Asked to copy quotations instead, every DeepSeek tier reworded archaic English roughly half the time (V4-Flash 43% accurate, V4-Pro 50%, V3.2 45%). Selecting ids, the cheapest tier renders 42 quotes across four questions with **zero** unverifiable. Misquoting stops being something to detect and becomes something that cannot be expressed.
4. **Every claim carries a citation or is removed.** A paragraph whose cited ids all turn out to be invented is dropped with them, and an answer left with no quote at all is replaced by an honest refusal rather than shipped as unsourced prose. Declining is stated explicitly by the model (`NOT COVERED:`) so a legitimate refusal is distinguishable from a bare assertion. Hand-read sample of 20 answers found 5 shipping unsupported claims; after this, a fresh sample of 14 gave 9 grounded, 5 honest refusals, 0 bare claims.
5. **`k` is a limit, not a target.** The reranker was asked for "at most 5" and returned 5 every
   time, so an answer quoted whatever stood near the subject rather than what answered. Being
   on the topic is not the same as carrying part of the answer, and a passage about death does
   not answer how a person should meet it. Told that plainly, and that there is no credit for
   filling the list, real questions come back with two or three passages instead of five.

   **It costs about one case, and the measurement cannot prove it costs nothing.** On the same
   40-case subset: search recall unchanged at 50%, which is the control, since this touches only
   the rerank step; shipped recall 33%→30%, MRR 0.283→0.252. That subset has measured 30% and
   33% on separate runs the same evening, so one case is inside its observed spread. A stricter
   judge that discards a passage which did hold the answer costs recall directly, and recall is
   already the architecture's ceiling, so this is a real trade and not a free win.

6. **One quotation per book, the first that survives verification.** The catalogue offers
   numbered *sentences*, so a single retrieved passage yields a dozen quotable ones and the
   model takes six of them: a question about death returned 22 blockquotes, ten from one book,
   every repeat carrying the same chunk-level citation. It read as one book being transcribed
   rather than several being consulted. Asked in the prompt, the model ignored it, so the rule
   is enforced after splicing. Whole blocks, because a claim and its quote are one unit and
   removing the quote alone leaves the claim unsourced, and a block survives if it quotes any
   book not yet seen, so a passage setting two traditions against each other is never dropped.
   Four blockquotes from four books now, where there were 22 from three. Gold citation stayed
   in its existing 10-11 of 11 band across four runs, so the diversity is not bought with recall.

7. **Verbatim-quote verifier**: a backstop behind the above. Every quoted span, blockquote or inline, must be a substring of a retrieved chunk; blocks resting on one that isn't are dropped and reported. It is the brand, and it should now never fire.

   **It was firing constantly, and it was wrong.** A citation is delimited by square brackets, and Gutenberg footnote markers put brackets *inside* chapter titles, `HEROISM[309]`. Nested one bracket pair inside another, the verifier could not strip the citation off the end of a quotation, so it checked the quotation with its citation still attached, found no book containing that text, and reported a perfectly real quote as fabricated. Every quotation from such a chapter was dropped. Emerson's *Essays* is full of them, so "what is courage?" answered *"I could not ground an answer"* while Emerson's *Heroism* sat in the retrieved passages.

   Measured on the 26 frozen answer cases, identical passages before and after: claims dropped **30 → 3**, ungrounded refusals **1 → 0**, gold citations **92% → 96%**. The lesson is not the regex. It is that a backstop which fails *closed* is invisible: it produced a safe-looking honest refusal every time, and the only symptom was a dropped-claims count that read as the model misbehaving. A verifier needs its own test, because nothing downstream can tell you it is wrong.

8. **A relevance floor, so a question the shelf cannot answer returns nothing rather than the
   least-bad five.** The reranker was already told to drop candidates that do not help, and an
   empty reply was read as a malfunction and undone by handing back the unranked top k. Asked
   `skeet?`, HyDE reached for clay pigeons, search matched Sankaracarya on clay pots, and the
   answer step explained whether the pot is real. `NONE` is now a verdict distinct from a reply
   that could not be parsed, and only the latter falls back.

   Batching hid half of it. A rerank call judges its own twenty and nothing else, so a batch of
   near-misses returns the best of a bad set; two batches answered `NONE` and the third picked
   five clay passages, and because five fitted in `k` the consolidation pass was skipped and
   nothing ever saw the whole result. That pass now always runs when the input was batched,
   which is the only place the floor can apply to what actually came back. Measured on 60 cases
   it cost nothing: recall@5 42%→48%, MRR 0.339→0.375, and the same 240 model calls, because
   the consolidation pass was already running whenever survivors overflowed `k`.

**Measured, all 151 cases, DeepSeek-V4-Flash via DeepInfra, rerank fallback rate 0%.**

Search recall by candidate depth, before any reranking:

| | @5 | @20 | @60 | @200 | @500 |
|---|---|---|---|---|---|
| hybrid search | 23% | 44% | 57% | 75% | 87% |
| + HyDE | 33% | 56% | **72%** | 83% | **92%** |

The launch stack takes the 60-deep list and reranks to 5: **recall@5 60%, MRR 0.505**.

Earlier versions of this table reported a "recall@20" column that was really recall at the
full candidate depth, because the eval scanned all `GURU_CANDIDATES` hits under a hardcoded
`@20` label. The old 56% and 73% figures are the 60-deep search numbers above, and they moved
with the depth setting rather than with the reranker. Nothing measured downstream of them was
wrong, but the funnel they implied was.

**The reranker is the ceiling, and it is the only thing that is.** Of 151 cases, search at depth
60 finds 72% and the reranker ships 60%. Feeding it a better list does not move that number.
A stronger embedder (`bge-large`) raised search to 78% at the same depth and shipped **59%**:
the reranker simply lost more, 19 points instead of 12. Going deeper does not work either,
because discrimination falls about as fast as depth adds recall (at 20 candidates the reranker
lost 3 of what search found, at 60 it lost 13), so the 20 further points sitting between depth
60 and depth 500 cannot be collected by widening the window. Three separate attacks, a local
cross-encoder, a larger embedder, more depth, all produced the same ~60%.

**A better reranker was the last component-level lever, and it is worse.** Measured with
`eval/rerank.ts` on 109 cases where search supplied the answer, each reranker seeing the
identical frozen candidate list, frozen because HyDE writes a different hypothetical every
time, and two rerankers compared across separate runs are graded on different candidates:

| reranker | recall@5 | MRR@5 | fallbacks |
|---|---|---|---|
| none, fused order | 54/109 50% |, |, |
| **DeepSeek-V4-Flash** (current) | **87/109 80%** | 0.643 | 0% |
| DeepSeek-V4-Pro (dearer tier) | 78/109 72% | 0.610 | 0% |

The reranker earns its four calls, 50% to 80%, and the cheaper model does it eight points
better. Neither run fell back, so this is not a parse failure: the dearer model simply chooses
worse, exactly as it did at the answer step. These figures also reconcile the shipped number ,
80% of the 72% that search finds is ~58%, which is the recall@5 60% above.

**So 60% is the architecture's ceiling, not any component's.** Four attacks have failed and all
four failed the same way, by improving one part while the shipped number stayed put: a local
cross-encoder (much worse), a stronger embedder (better search, identical output), more candidate
depth (discrimination loss cancels the gain), and a stronger reranker (worse). Raising this needs
a different design, not a better part.

**Chunk size was the last cheap lever, and it is already at its optimum for a reason worth
knowing.** Swept with `eval/chunks.ts`, search only, so it costs nothing and cannot vary between
runs. Scored on the 149 cases whose gold passage survives chunking in every configuration,
because smaller chunks split some of them and scoring each database against whatever it happens
to contain compares different case sets:

| chunk chars | chunks | recall@5 | recall@20 | recall@60 |
|---|---|---|---|---|
| 1000 | 6049 | 25% | 40% | 53% |
| **2000 (default)** | 3331 | 23% | 41% | **56%** |
| 3000 | 2401 | 5% | 21% | 39% |

1000 and 2000 trade a couple of cases, which is noise. The collapse at 3000 is not: **bge-base's
512-token window is about 2100 characters of English prose**, measured by embedding a passage
and its prefixes until the vectors come out identical. Past that the text is dropped, so a
3000-char chunk loses a third of itself before it is ever embedded, and that third is invisible
to vector search while still being quotable from the stored text.

Nothing reported this. Raising `GURU_CHUNK_CHARS` looks like ordinary tuning and silently
destroys retrieval, so `src/embed.ts` now warns when a passage exceeds the window. The real
constraint is that **chunk size is bounded above by the embedder's context window**, not by
anything about the books, and any future embedder swap moves that bound with it.

Next is the v2 concept graph.

**Launch decision: 60% is the shipping number.** The 40% that miss produce an honest "your
library doesn't cover this", not a fabricated quote, so the brand promise holds at this recall.
The eval is also deliberately adversarial, cases are rejected when query and answer share more
than a quarter of their content words, so all 151 are hard paraphrases and real reader questions
should score better. That is an assumption, not a measurement: instrument real queries after
launch and re-set the bar against them.

**A local cross-encoder reranker was tried and reverted.** `Xenova/bge-reranker-base` scoring
each query/passage pair directly is the obvious fix for a reranker that can only judge twenty
candidates at a time: no API cost, no rate limit, depth becomes free. On 15 cases it scored
recall@5 **20%** against the LLM reranker's 60%, throwing away 11 of the 14 chunks search had
found. Feeding it the HyDE text instead of the plain question, so the register matches, changed
nothing. The model is trained on modern web QA and reads a 19th-century translation as
irrelevant: asked "can the eternal way be put into words?" it scored "The Tao that can be
trodden is not the enduring and unchanging Tao" at 0.0001. What the LLM reranker is really
being paid for is the instruction to judge across translations and traditions, and no
off-the-shelf cross-encoder carries that. Retry only with a reranker shown to handle archaic
register, judged on the eval.

Two things are settled. One rerank call can only discriminate among roughly twenty candidates,
so deep candidate sets are judged in batches; a single call over sixty scores no better than one
over twenty. And HyDE is worth fifteen points of recall@5 even on top of batching, so it stays.

`bge-large` was the obvious way to move the whole curve left and was measured on the full 151
(see above): better search, identical shipped recall. It stays selectable in `src/embed.ts` for
future comparison but is not the default.

**Retrieval is no longer the only thing between this and launch.** 40% of questions still
miss, but the answer model now matters as much: a budget model reliably fails to copy
archaic English character for character, and the verifier correctly refuses it. On one
Stoic/devotional question DeepSeek-V3.2 produced eleven unverifiable quotes and one good
one. Model choice for the answer step is a quality decision, not a cost decision.

**The eval is part of the stack, not a nice-to-have.** Chunk size, embedder, fusion depth, and contextual retrieval are all knobs whose right setting is a measurement. A 10-case eval measured HyDE as noise and nearly got it discarded; at 90 cases it was the single biggest win. Cases are generated from the corpus and rejected when query and answer share more than a quarter of their content words, so they test meaning rather than word overlap.

**v2 (revenue-funded): concept knowledge graph.** LLM extracts (concept, relation, concept, source-chunk) triples at ingest into the same SQLite; graph hops expand retrieval before rerank. Powers cross-tradition queries ("what do Ramana and Eckhart agree on"). ColBERT/late-interaction: not planned unless quality data demands it.

## Agent

- Single agent, warm scholar-teacher persona. Answers **only** from retrieved passages; says "your library doesn't cover this" instead of hallucinating.
- Model routing: Haiku-tier for pipeline steps (contextualizing, rerank, query rewrite), Sonnet-tier for the answer. **Built as two independent settings** (`GURU_PIPELINE_MODEL`, `GURU_ANSWER_MODEL`), though the measurement below says the dear tier buys nothing at the answer step.
- Streaming: **partial.** The page updates over SSE as the stages complete, so the reader sees how many passages were found while the answer is being composed, but the answer itself arrives in one event rather than token by token.
- Conversation memory: last-N messages. **Not built.** Every question is answered standing alone; there is no thread, and a follow-up that says "and what about him?" has nothing to resolve it against. This is the largest unbuilt thing in this section and it is a product gap, not a technical one.

## Architecture & security

- **SQLite-per-user** (sqlite-vec + FTS5): one file per user = isolation by filesystem, no `WHERE user_id` bug can leak book A to user B. Microsecond queries, trivial data export/delete.
- **Litestream** continuous replication to S3. Encryption at rest + TLS. **Not built. What is
  built is a nightly `VACUUM INTO` snapshot of every database on the volume, rotated seven days,
  with a restore test that opens each one and reads text back (`deploy/backup.sh`,
  `deploy/backup-verify.sh`).** That covers deletion, corruption and a bad deploy. It does not
  cover losing the disk, because it lives on it: the script copies off-site through `rclone`
  when `GURU_BACKUP_REMOTE` is set, and says on every run when it is not. Litestream would be
  better than nightly snapshots (continuous, so the window is seconds rather than a day) and
  still needs the same thing this does, a bucket.
- Hosting: Fly.io / Hetzner / Railway-class with persistent volumes (SQLite rules out pure serverless).
- Auth: managed (Clerk/WorkOS), never hand-rolled. Billing: Stripe.
- GDPR-shaped from day one: per-user export + delete endpoints. **Built**, `GET /export` streams the reader's SQLite file (books, chunks, and usage all travel together, since it is one file), `POST /delete` removes it along with its `-wal`/`-shm` sidecars, queued uploads, and job rows. Where `GURU_LIBRARIAN` names who may take the corpus away, everyone else exports their ask history as JSON instead: the books are not theirs, and `asks` holds timestamps and no question text, so that history is the whole of what is. Deletion is not gated, since removing your own library costs nobody else anything.
- SOC2 / pen test / WAF: deferred until an institutional buyer asks.

## Pricing

~$10-15/mo subscription. Fair-use caps: ~50 books ingested (enforced), and a daily question
allowance (`GURU_MAX_ASKS`, default 40).

**The cost model here was backwards, and measuring it inverted both halves.** Ingest is not the
spike: embeddings are local `bge-base` on CPU (no API call anywhere in the embed path, weights
baked into the image), and contextual retrieval is deferred, so **adding a book costs zero API
dollars**. Chat is where the money goes, and reranking is most of it, four batched calls
carrying ~16k input tokens against roughly 3k for the answer.

The absolute figure depends entirely on which models the pipeline is pointed at, and the two
plausible stacks are twenty times apart:

| stack | per answer | 40 answers/day |
|---|---|---|
| DeepSeek-V4-Flash on DeepInfra (deployed, now the `-0731` build), $0.09/$0.18 per Mtok | **~$0.002** | ~$2.40/month |
| Haiku pipeline + Sonnet answers on Anthropic (SPEC's intent), $1/$5 and $3/$15 | **~$0.04** | ~$48/month |

Prompt caching does not rescue either one: the rerank prompt carries a different candidate set
every query, so there is no stable prefix to cache, and Haiku-tier caching needs 4096 tokens of
one anyway. The daily allowance exists because the *expensive* configuration would outspend a
$12 subscription at around ten questions a day. On what is actually running it is comfortable,
which is an argument for keeping the cheap stack rather than for removing the cap.

**Measured: the expensive answer model buys nothing.** `eval/answers.ts` scores the step the
retrieval eval cannot, given passages that *do* contain the answer, does the model quote the
right one? It needs no judge, because the cases already carry the gold passage. On 18 cases
where retrieval supplied the answer, every model reading the identical passages:

| answer model | cited the gold passage | refused despite gold | claims dropped |
|---|---|---|---|
| DeepSeek-V4-Flash (cheapest) | **16/18 89%** | 2 | 20 |
| DeepSeek-V4-Pro | 15/18 83% | 3 | 19 |
| DeepSeek-V3.2 | 13/18 72% | 5 | 15 |

The cheapest tier is at least as good as the dearest, which is what quote-by-reference was
supposed to buy: a model that only selects sentence ids needs far less capability than one
asked to transcribe archaic English. The note above that model choice here is "a quality
decision, not a cost decision" was written in the transcription era and no longer holds.
Differences of one to three cases at n=18 are noise; what the run rules out is the expensive
model being *better*. **This shifts the intended production stack**, SPEC's Sonnet-tier answers
look over-specified, and Haiku-tier answers would take a question from ~$0.04 to ~$0.017. Not
yet confirmed on Anthropic models, which needs a key this repo does not have.

**Two answer-quality problems the same run exposed, both worse than the cost question.** Even
the best model refused 11% of questions whose answer was sitting in front of it, and roughly
one claim per answer cites an id that does not exist and is dropped. Both are invisible to the
retrieval eval and neither is fixed by spending more on the model.

**Run it on identical passages.** Retrieval is stochastic, HyDE writes a different hypothetical
each time and the reranker is an LLM, so re-retrieving per model grades each on a different set
of cases. Done that way, V4-Pro first measured 100% against V4-Flash's 75%; sharing one
retrieval pass reversed the ranking outright.

## Stack

**TypeScript core** (backend + web + MCP: one language, one deployable; reference MCP SDK) · better-sqlite3 + sqlite-vec + FTS5 + Litestream · hosted LLM API (a large model for answers, a small one for the pipeline) · Clerk/WorkOS · Stripe · Fly.io-class host. Web UI: minimal, calm, fast (SSR or thin React, decide at build).

**Ingest sidecar: Python** (~50 lines, pymupdf + ebooklib), PDF/EPUB in → JSON chunks with page numbers out, run by a queue worker in its sandbox. The language boundary doubles as the security boundary. Rationale: bottleneck is LLM latency, not runtime; PyMuPDF is the only irreplaceable Python dependency. Rust/Go rejected: they optimize microseconds in a pipeline dominated by seconds-long API calls, at solo-dev iteration cost; Rust reconsidered only for a profiled retrieval bottleneck or a future local/desktop build.

## Milestones

1. ~~Ingest with page-accurate metadata~~ **done**. Query a known quote, get the right page. Contextual enrichment built but deferred (see Ingestion).
2. ~~Chat with cited answers, verifier passing. CLI/API first.~~ **done**. Retrieval closed at recall@5 60% (see Retrieval), the reranker is a measured ceiling and further search work does not move the shipped number.
3. Web SaaS: auth, billing, upload, starter library. **Launch.** *Partly built:* auth (Clerk, or
   `GURU_BASIC_AUTH` for a shelf shared with people you know), upload, and the starter library
   are done and deployed. **Billing is not started**, and neither is Litestream replication, so
   every reader's library is one file on one volume with no backup. The corpus is reproducible
   from Gutenberg; a reader's own uploads and history are not.
4. MCP endpoint fast-follow (paid perk).
5. v2: concept knowledge graph → cross-tradition synthesis as the headline feature.

## Non-goals (launch)

KG (v2), ColBERT, mobile apps, devotional/practice features (different lane), fine-tuning, SOC2, teams.
