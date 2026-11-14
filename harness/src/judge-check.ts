/**
 * Check the judge before trusting it. For each question:
 *
 * - its own gold answer, graded as an answer, should pass: every must point met, no penalty;
 * - the gold answer of a different question should score near 0.
 *
 * A judge that fails either is reading the points wrong, and its scores mean little.
 *
 *     npm run judge-check -- --ids nz-d01,nz-d02 --yes
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { config } from "./config.ts";
import { judge } from "./judge.ts";
import { scoreAnswer } from "./score.ts";
import { loadSet } from "./set.ts";

const { values } = parseArgs({
  options: {
    set: { type: "string", default: "sets/nz-dev.jsonl" },
    ids: { type: "string" },
    yes: { type: "boolean", default: false },
  },
});

const all = loadSet(values.set).questions;
const ids = values.ids?.split(",").map((s) => s.trim());
const questions = all.filter((q) => !ids || ids.includes(q.id));
console.log(`Judge check with ${config.judge.model}: ${questions.length} question${questions.length === 1 ? "" : "s"}, 2 judge calls each (about $${(questions.length * 0.06).toFixed(2)}).`);
if (!values.yes) {
  console.log("Add --yes to go ahead.");
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const rows = await Promise.all(
  questions.map(async (q) => {
    const other = all[(all.indexOf(q) + 1) % all.length]!;
    const date = q.date ?? today;
    const [own, wrong] = await Promise.all([judge(q, q.gold, date), judge(q, other.gold, date)]);
    const ownScore = scoreAnswer(q, own, false);
    const wrongScore = scoreAnswer(q, wrong, false);
    const ok = ownScore.strict === true && (wrongScore.score ?? 0) <= 0.2;
    return { id: q.id, gold: ownScore, wrong: wrongScore, ok, dollars: own.dollars + wrong.dollars, own, wrongVerdicts: wrong };
  }),
);

for (const r of rows) {
  console.log(
    `  ${r.ok ? "✓" : "✗"} ${r.id}: gold as answer ${r.gold.score?.toFixed(2)} (${r.gold.strict ? "passes" : "FAILS"}), another question's gold ${r.wrong.score?.toFixed(2)}`,
  );
}
const passed = rows.filter((r) => r.ok).length;
console.log(`${passed} of ${rows.length} as expected · $${rows.reduce((s, r) => s + r.dollars, 0).toFixed(3)}`);
mkdirSync(config.resultsDir, { recursive: true });
const file = join(config.resultsDir, `judge-check-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ judge: config.judge.model, rows }, null, 2) + "\n");
console.log(`details: ${file}`);
