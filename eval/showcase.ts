// Saves the landing page example answer from a real Ask against a running server.
//
//   node eval/showcase.ts "How do I stop worrying about things I can't control?"
//
// GURU_URL names the server (default http://localhost:8080). GURU_SHOWCASE_AUTH is a
// user:password for a basic-auth reader, ideally an operator so the run spends no allowance.
// The answer goes through the same route a visitor uses, so every quotation is spliced from the
// source and checked. The suggested questions already in the file are kept.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { profile } from "../src/profile.ts";

const question = process.argv[2];
if (!question) throw new Error("usage: node eval/showcase.ts QUESTION");
const base = process.env.GURU_URL ?? "http://localhost:8080";
const auth = process.env.GURU_SHOWCASE_AUTH;
const out = join(profile.assets, "showcase.json");

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

// Source buttons carry this library's book revision, which another build of the same starter
// does not share. The saved copy keeps the citation text and drops the button.
html = html.replace(/<button type="button" class="source"[^>]*>(.*?)<\/button>/g, "$1");
const previous = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
writeFileSync(out, JSON.stringify({
  question,
  generated: new Date().toISOString().slice(0, 10),
  answerModel: process.env.GURU_ANSWER_MODEL || undefined,
  html,
  suggestions: previous.suggestions ?? [],
}, null, 2) + "\n");
console.log(`wrote ${out}`);
