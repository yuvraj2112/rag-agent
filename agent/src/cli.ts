/**
 * Ask one question from the terminal:
 *
 *     npm run ask -- "What is the GST registration threshold?"
 *     npm run ask -- "..." --country nz --date 2026-04-01
 *
 * Prints the answer, what it cites, and what it cost; the full record is saved in runs/.
 */

import { parseArgs } from "node:util";

import { COUNTRIES, localToday, type Country } from "./prompt.ts";
import { runQuestion, setup } from "./run.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { country: { type: "string", default: "nz" }, date: { type: "string" } },
});
const question = positionals.join(" ").trim();
if (!question || !(values.country in COUNTRIES)) {
  console.error('usage: npm run ask -- "your question" [--country nz] [--date YYYY-MM-DD]');
  process.exit(1);
}

const reply = await runQuestion(
  { question, country: values.country as Country, today: values.date ?? localToday() },
  setup(),
);
const t = reply.run.totals;
console.log(reply.answer || "(no answer)");
console.log(`\n— ${reply.status} (${reply.stopReason})${reply.error ? `: ${reply.error}` : ""}`);
for (const s of reply.sources) console.log(`  [${s.id}] ${s.title}${s.section ? `, ${/^schedule/i.test(s.section) ? "" : "s "}${s.section}` : ""}`);
if (reply.unknownCitations.length > 0) console.log(`  cites ids it never read: ${reply.unknownCitations.join(", ")}`);
console.log(`  ${t.modelCalls} model calls, ${t.toolCalls} tool calls, ${t.seconds} s, $${t.dollars.toFixed(3)}`);
console.log(`  record: ${reply.run.record}`);
