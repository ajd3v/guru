// Saves the landing page example answer from a real Ask against a running server.
//
//   node eval/showcase.ts "How do I stop worrying about things I can't control?"
//
// GURU_URL names the server (default http://localhost:8080). GURU_SHOWCASE_AUTH is a
// user:password for a basic-auth reader, ideally an operator so the run spends no allowance.
// The answer goes through the same route a visitor uses, so every quotation is spliced from the
// source and checked. The suggested questions already in the file are kept.
//
// The model's own prose (the synopsis and the paragraphs between quotations) has to follow the
// voice rules in the answer prompt. A run that breaks them is asked again, twice at most, and
// then the script fails. Nothing here edits what the model wrote.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { profile } from "../src/profile.ts";

const question = process.argv[2];
if (!question) throw new Error("usage: node eval/showcase.ts QUESTION");
const base = process.env.GURU_URL ?? "http://localhost:8080";
const auth = process.env.GURU_SHOWCASE_AUTH;
const out = join(profile.assets, "showcase.json");

async function askOnce() {
  const response = await fetch(`${base}/ask`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/x-www-form-urlencoded",
      ...(auth ? { authorization: `Basic ${Buffer.from(auth).toString("base64")}` } : {}),
    },
    body: new URLSearchParams({ q: question, mode: "ask" }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(`ask failed (${response.status})`);
  let html = "";
  for (const frame of (await response.text()).split("\n\n")) {
    if (/^event: answer$/m.test(frame)) html = JSON.parse(frame.match(/^data: (.*)$/m)![1]).html;
  }
  if (!/<blockquote>/.test(html)) throw new Error(`no quoted answer came back:\n${html}`);
  if (/could not be verified/.test(html)) throw new Error("a quotation failed the check, ask again rather than ship a partial answer");
  return html;
}

const plain = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[e]!).trim();

/** What is wrong with the model's own prose, empty when nothing is. */
function voiceProblems(html: string) {
  const lead = plain(html.match(/<p class="synopsis">(.*?)<\/p>/s)?.[1] ?? "");
  const body = (html.match(/<div class="answer">(.*?)<\/div>/s)?.[1] ?? "").replace(/<blockquote>.*?<\/blockquote>/gs, "");
  const commentary = [...body.matchAll(/<p>(.*?)<\/p>/gs)].map((m) => plain(m[1]));
  const problems: string[] = [];
  for (const text of [lead, ...commentary]) {
    if (text.includes(";")) problems.push(`semicolon in "${text}"`);
    if (/:\s/.test(text)) problems.push(`colon joining clauses in "${text}"`);
  }
  return problems;
}

let html = "";
for (let attempt = 1; ; attempt++) {
  html = await askOnce();
  const problems = voiceProblems(html);
  if (!problems.length) break;
  console.error(`attempt ${attempt} broke the voice rules:\n  ${problems.join("\n  ")}`);
  if (attempt === 3) throw new Error("the answer prose still breaks the voice rules after 3 attempts, nothing written");
}

// Source buttons carry this library's book revision, which another build of the same starter
// does not share. The saved copy keeps the citation text and drops the button.
html = html.replace(/<button type="button" class="source"[^>]*>(.*?)<\/button>/g, "$1");
const previous = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
writeFileSync(out, JSON.stringify({
  question,
  html,
  suggestions: previous.suggestions ?? [],
}, null, 2) + "\n");
console.log(`wrote ${out}`);
