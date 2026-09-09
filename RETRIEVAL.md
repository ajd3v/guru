# Retrieval checks

Local measurements on September 9, 2026 support vector weight 2 for Guru. Other applications keep the default weight 1 until their own cases justify a change. The engine remains shared.

## Changes

- Hybrid search fuses keyword and vector ranks. Guru gives vector ranks twice the weight. Both lists have depth 180 when the candidate limit is 60. See [src/store.ts](src/store.ts).
- Quoted multiword phrases receive priority only when they occur in stored source text. Generated index context cannot earn that priority. Ask passes the original reader query separately from its generated expansion.
- Find previews and reranker inputs use one unchanged source window around query terms. Truncation is marked. The answer renderer still selects from the full source passage. See [src/excerpt.ts](src/excerpt.ts).
- The sentence catalogue includes source metadata and allows short sentences such as "Be still." A single candidate now receives a relevance check. See [src/llm.ts](src/llm.ts).
- CLI Find uses local retrieval without a model endpoint. Concurrent requests share the embedder's initial load.

## Observed results

Both snapshots used BGE base embeddings and 163 positive cases. All cases were eligible, with zero exclusions. Counts measure whether any chunk containing the expected source span reached the requested rank.

| Snapshot | Books / chunks | Previous top 5 | Current top 5 | Previous top 60 | Current top 60 |
| --- | --- | --- | --- | --- | --- |
| Reference library | 14 / 3,331 | 38/163 | 43/163 | 92/163 | 97/163 |
| Deployed starter copy | 123 / 35,036 | 15/163 | 18/163 | 56/163 | 57/163 |

The larger library remains difficult. These gains do not establish good answer coverage.

On the deployed copy, 78/163 expected spans appeared in the old 700-character prefix. The focused excerpt exposed 102/163, with 39 gains and 15 losses. This counts all gold passages, including ones search missed. Within retrieved candidates, expected-span visibility rose from 32/163 to 42/163. No composed answers were scored.

The original 151 cases contain 10 hand-written cases and 141 generated cases. Eight ranking variants were compared on a fixed 72-case development split. The chosen vector weight improved top-five hits on the original 79-case holdout from 18 to 20 in the reference library. Twelve reader-style cases were then added and checked against their stated books. Their explicit holdout assignment takes precedence over the hash split. These exposed cases should not be treated as fresh holdout data for later tuning.

[eval/results/retrieval-2026-09-09.json](eval/results/retrieval-2026-09-09.json) records the configuration and dataset fingerprints. It includes the engine file hash and both search-index hashes. Measurements used Node 26.7.0 on isolated database copies. Tests also run on Node 24 in CI. No provider evaluation calls were made.

## Repeat

```sh
GURU_NO_DOTENV=1 GURU_DB=/path/to/isolated/library.db npm run eval:compare -- --output /tmp/retrieval.json
GURU_NO_DOTENV=1 GURU_DB=/path/to/isolated/library.db npm run eval:compare -- --split holdout --output /tmp/holdout.json
```

The baseline uses equal weights without phrase priority. The candidate uses the configured weight and source-verified phrase priority. The output lists every selected case and exclusion. Timing starts after model loading, but is not a controlled performance benchmark.

The score accepts an expected span in any matching book. It does not check edition identity or semantic support. Negative questions are outside this positive retrieval denominator. Stub tests verify refusal handling, including a lone irrelevant candidate. They do not measure real-model refusal accuracy.

Next, measure the full Ask path on supported and unsupported reader questions. Query expansion can change candidate coverage, and focused excerpts can change reranker decisions. Estimate the selected models' charges before those runs. Source transcription and page accuracy still require separate checks.

## Search within a book

The web form now offers a Search in selector. Find and Ask can use a single book, including a specific copy when titles repeat. All books remains the default. The CLI supports `books` to list IDs and `find --book ID` or `ask --book ID` to select one.

The selected book limits keyword and vector candidates before their ranking limits. Literal phrase priority follows the same scope. Query expansion cannot widen it. Invalid or missing book IDs fail before provider calls or question charges. Source IDs belong to the current reader's library. They are not permanent edition identifiers across library replacement.

Results and exported question logs retain the selected book's filename and ID. Validation errors and upstream failures preserve selection for the next submission. The native selector has a visible label and a 44-pixel minimum height. Desktop and 390-pixel browser checks found no horizontal overflow and opened the selected source correctly. This was a focused flow check, not a full accessibility audit.

Twelve existing reader questions were paired with an explicit title and author in `eval/cases.sources.json`. On the isolated 123-book snapshot, source-correct top-five hits rose from 1/12 without selection to 7/12 with selection. Top-60 hits rose from 4/12 to 11/12. Both sides used vector weight 2 with the current phrase behavior. All 12 cases were eligible, with zero exclusions and no candidates outside the selected book.

These are conditional results for a reader who chooses the book. The questions were already known. They do not show better whole-library ranking or measure answer support. The regular evaluation still has 163 cases. A separate comparison against the previous engine returned identical unrestricted results and scores for all 163 queries.

[eval/results/source-selection-2026-09-09.json](eval/results/source-selection-2026-09-09.json) records every case and the fingerprints. Unlike the earlier any-book metric, this mode counts a gold span only in its declared source. Missing sources and ambiguous title-author pairs are excluded with explicit reasons. An absent expected span is also excluded. An isolated fixture verified all three paths and a failing exit status when no cases are eligible. No provider evaluation ran.

```sh
GURU_NO_DOTENV=1 GURU_DB=/path/to/isolated/library.db npm run eval:compare -- --source-cases eval/cases.sources.json --output /tmp/source-selection.json
```
