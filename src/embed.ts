import { pipeline } from "@huggingface/transformers";

// ponytail: local embedders, no API key and no per-chunk cost. Selectable so the eval can
// compare them on identical data, MiniLM measurably ranked known passages 60th-150th on a
// 1400-chunk corpus, which is how BGE became the default.
const MODELS = {
  // BGE is trained asymmetrically: queries get an instruction, passages get none.
  // Embedding a query as if it were a passage costs real recall.
  "bge-base": {
    id: "Xenova/bge-base-en-v1.5",
    dim: 768,
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  // Better search, same shipped answers: on 151 cases it found the right chunk 6 points more
  // often at depth 60 and the reranker gave every point back (59% vs 60% recall@5). Not the
  // default, it costs 3x the ingest CPU and a 16% larger database for no measured gain.
  "bge-large": {
    id: "Xenova/bge-large-en-v1.5",
    dim: 1024,
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  "minilm": { id: "Xenova/all-MiniLM-L6-v2", dim: 384, pooling: "mean", queryPrefix: "" },
} as const;

const MODEL = MODELS[(process.env.GURU_EMBED ?? "bge-base") as keyof typeof MODELS];
if (!MODEL) throw new Error(`GURU_EMBED must be one of: ${Object.keys(MODELS).join(", ")}`);

export const DIM = MODEL.dim;
export const MODEL_ID = MODEL.id;

/**
 * Roughly where the model's 512-token window falls on English prose, measured rather than
 * assumed: embedding a passage and its first N characters returns an identical vector from
 * about 2100 chars up, so everything past that is discarded.
 *
 * This is why `GURU_CHUNK_CHARS` defaults to 2000. Raising it looks like ordinary tuning and
 * silently deletes the tail of every chunk: at 3000 chars a third of each one never reaches
 * the embedder, and search recall@5 measured 5% against 23% at the default.
 */
const WINDOW_CHARS = 2100;
let warned = false;

// ponytail: fixed batch. Embedding a whole book in one call is what the caller wants to
// write, and it gets the process OOM-killed somewhere north of a few hundred chunks.
const BATCH = 32;

let extractor: Promise<any> | undefined;

export async function embed(texts: string[], kind: "passage" | "query" = "passage") {
  extractor ??= pipeline("feature-extraction", MODEL.id).catch((error) => {
    extractor = undefined;
    throw error;
  });
  const model = await extractor;
  const input = kind === "query" ? texts.map((t) => MODEL.queryPrefix + t) : texts;

  // Say so, once, rather than let a third of every chunk vanish without a word.
  const over = input.filter((t) => t.length > WINDOW_CHARS).length;
  if (over && !warned) {
    warned = true;
    const longest = Math.max(...input.map((t) => t.length));
    console.error(
      `warning: ${over} passage(s) exceed ~${WINDOW_CHARS} chars (longest ${longest}); ` +
        `everything past that is dropped before embedding. Lower GURU_CHUNK_CHARS and re-ingest.`,
    );
  }

  const vectors: Float32Array[] = [];
  for (let i = 0; i < input.length; i += BATCH) {
    const out = await model(input.slice(i, i + BATCH), {
      pooling: MODEL.pooling,
      normalize: true,
    });
    vectors.push(...out.tolist().map((a: number[]) => new Float32Array(a)));
  }
  return vectors;
}
