import { pipeline } from "@huggingface/transformers";

export const DIM = 384;

// ponytail: local MiniLM. No API key, no per-chunk cost, and hybrid search leans on BM25
// for exact-quote lookup anyway. Swap this one function for Voyage if recall data demands it.
let extractor: any;

export async function embed(texts: string[]): Promise<Float32Array[]> {
  extractor ??= await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  return out.tolist().map((a: number[]) => new Float32Array(a));
}
