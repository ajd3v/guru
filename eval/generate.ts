// Builds eval cases from the corpus: sample a passage, have a model write the question a
// reader would ask to find it, keep a verbatim span as the expected answer.
//
//   node eval/generate.ts [count] > eval/cases.generated.json
//
// The whole risk here is vocabulary leakage. A generated query that reuses the passage's
// wording tests BM25 echo, not retrieval, so anything above MAX_OVERLAP is thrown away and
// the rejection rate is reported — if it is low, the filter is not doing its job.
import { readFileSync } from "node:fs";
import { open } from "../src/store.ts";

const DB = process.env.GURU_DB ?? "data/eval-3book.db";
const WANT = Number(process.argv[2] ?? 80);
const MAX_OVERLAP = 0.25;
const CONCURRENCY = 6;

const STOP = new Set(
  ("the a an and or but of to in on at by for with is are was were be been it its this that " +
    "he she they them his her their we you i not no as if then than so such from what which " +
    "who whom when where why how do does did done have has had all any some more most other").split(" "),
);
const words = (s: string) =>
  new Set(
    (s.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)),
  );

/** Jaccard over content words. High overlap means the query leaked the passage's wording. */
function overlap(query: string, passage: string) {
  const a = words(query);
  const b = words(passage);
  if (!a.size) return 1;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / a.size;
}

const db = open(DB);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

// Stratify across books so one long book can't dominate the set.
const books = db.prepare("select id, title from books").all() as any[];
const perBook = Math.ceil((WANT * 1.6) / books.length); // over-sample; many get rejected
const sample: any[] = [];
for (const b of books) {
  sample.push(
    ...(db
      .prepare(
        "select c.id, c.text, b.title from chunks c join books b on b.id = c.book_id " +
          "where c.book_id = ? and length(c.text) > 600 order by random() limit ?",
      )
      .all(b.id, perBook) as any[]),
  );
}

// Shuffle, or the run stops at WANT while walking books in order and the last book gets
// no cases at all — which silently drops a whole register from the eval.
for (let i = sample.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [sample[i], sample[j]] = [sample[j], sample[i]];
}

const Anthropic = (await import("@anthropic-ai/sdk")).default;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "local" });
// Generation quality decides eval quality, so this defaults to a stronger model than the
// retrieval pipeline uses. Small/reasoning models here continue the passage instead of
// answering, or burn the whole budget deliberating.
const MODEL = process.env.GURU_GEN_MODEL ?? process.env.GURU_PIPELINE_MODEL ?? "claude-sonnet-5";

async function makeCase(chunk: any) {
  const m = await client.messages
    .stream({
      model: MODEL,
      max_tokens: 600,
      system:
        "You write evaluation cases for a search system. Reply in exactly the requested " +
        "format and nothing else.",
      messages: [
        {
          role: "user",
          content:
            `Passage from "${chunk.title}":\n\n${chunk.text.slice(0, 1200)}\n\n---\n` +
            `Write the question a curious reader would ask that this passage answers.\n` +
            `Rules:\n` +
            `- Ask it in plain modern English, the way someone would type it into a search box.\n` +
            `- Do NOT reuse the passage's distinctive words. If it says "Tao", ask about "the way".\n` +
            `  If it says "contrition", ask about "feeling sorry". Paraphrase everything.\n` +
            `- Then quote the single sentence from the passage that best answers it, copied exactly.\n\n` +
            `Reply in exactly this form and nothing else:\n` +
            `Q: <the question>\n` +
            `A: <the exact sentence from the passage>`,
        },
      ],
    })
    .finalMessage();

  const text = m.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  const query = /^Q:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const expect = /^A:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^["“]|["”]$/g, "");
  if (!query || !expect || expect.length < 25) return { reason: "malformed" };

  // The quoted sentence must really be in the chunk, or the case tests nothing.
  if (!flat(chunk.text).includes(flat(expect))) return { reason: "not verbatim" };

  const ov = overlap(query, expect);
  if (ov > MAX_OVERLAP) return { reason: `leaked (${ov.toFixed(2)})` };

  return { case: { query, expect: flat(expect), book: chunk.title.slice(0, 40), overlap: +ov.toFixed(2) } };
}

const cases: any[] = [];
const rejects: Record<string, number> = {};
for (let i = 0; i < sample.length && cases.length < WANT; i += CONCURRENCY) {
  const results = await Promise.all(
    sample.slice(i, i + CONCURRENCY).map((c) => makeCase(c).catch((e) => ({ reason: `error: ${e.message.slice(0, 40)}` }))),
  );
  for (const r of results as any[]) {
    if (r.case) cases.push(r.case);
    else rejects[r.reason.replace(/\(.*\)/, "(overlap)")] = (rejects[r.reason.replace(/\(.*\)/, "(overlap)")] ?? 0) + 1;
  }
  console.error(`${cases.length}/${WANT} accepted, ${Object.values(rejects).reduce((a, b) => a + b, 0)} rejected`);
}

console.error(`\nrejections: ${JSON.stringify(rejects)}`);
console.error(`mean overlap of accepted: ${(cases.reduce((a, c) => a + c.overlap, 0) / cases.length).toFixed(3)}`);
console.log(JSON.stringify(cases, null, 1));
