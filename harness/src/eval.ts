/**
 * The eval loop: ask → check → judge → score → report.
 *
 *     npm run eval -- --agent http://localhost:8787 --name first-try
 *
 *     --agent        the agent to test (default http://localhost:8787)
 *     --set          the question set (default sets/nz-dev.jsonl)
 *     --type         question types, e.g. T1,T5 (default all)
 *     --ids          particular questions, e.g. nz-d01,nz-d02
 *     --runs         answers per question (default 3)
 *     --name         the results folder (default: today, the model and the tools)
 *     --concurrency  questions asked at once (default 5)
 *     --yes          spend without asking
 *
 * Before spending it says how many answers it will get and what they may cost, and stops unless
 * --yes is given. Running the same --name again carries on where it stopped: saved answers and
 * verdicts are never paid for twice. A run is tied to the agent it started with: if the agent's
 * stamps change, it refuses, and you start a new --name.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { askAll, health, savedAnswer } from "./ask.ts";
import { config } from "./config.ts";
import { judge, judgeModel } from "./judge.ts";
import { writeReport } from "./report.ts";
import { loadRun, type RunMeta } from "./score.ts";
import { loadSet } from "./set.ts";
import { stampDiff } from "./stats.ts";

const { values } = parseArgs({
  options: {
    agent: { type: "string", default: "http://localhost:8787" },
    set: { type: "string", default: "sets/nz-dev.jsonl" },
    type: { type: "string" },
    ids: { type: "string" },
    runs: { type: "string", default: "3" },
    name: { type: "string" },
    concurrency: { type: "string", default: "5" },
    yes: { type: "boolean", default: false },
  },
});

const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null);
const types = list(values.type);
const ids = list(values.ids);
const runs = Number(values.runs);
const agent = values.agent.replace(/\/+$/, "");

const set = loadSet(values.set);
const questions = set.questions.filter((q) => (!types || types.includes(q.type)) && (!ids || ids.includes(q.id)));
if (questions.length === 0) throw new Error("no questions match --type and --ids");

const stamps = await health(agent);
const model = stamps.model as { provider: string; name: string } | undefined;
const tools = (stamps.tools as { name: string }[] | undefined)?.map((t) => t.name) ?? [];
const name = values.name ?? `${new Date().toISOString().slice(0, 10)}-${model?.name ?? "agent"}-${tools.length ? `${tools.length}tools` : "notools"}`;
const dir = join(config.resultsDir, name);
const runFile = join(dir, "run.json");

if (existsSync(runFile)) {
  const held = JSON.parse(readFileSync(runFile, "utf8")) as RunMeta;
  const changed = stampDiff(held.stamps, stamps);
  if (changed.length > 0) {
    throw new Error(`run "${name}" was made with a different agent (${changed.join(", ")}); start a new --name`);
  }
}

const toAsk = questions.flatMap((q) => Array.from({ length: runs }, (_, i) => i + 1).filter((k) => !savedAnswer(dir, q.id, k))).length;
const judgeProvider = judgeModel().provider;
console.log(`Run "${name}": ${questions.length} questions × ${runs} = ${questions.length * runs} answers, ${toAsk} still to ask.`);
console.log(`  agent ${agent}: ${model?.name ?? "?"} with ${tools.join(", ") || "no tools"}`);
console.log(`  judge ${config.judge.model}`);
if (model && model.provider === judgeProvider) {
  console.log(`  ⚠ the judge is from the agent's own model family (${judgeProvider}): it may favour answers like its own.`);
}
const cap = (stamps.limits as { dollars?: number } | undefined)?.dollars ?? 3;
console.log(`  cost: each answer can cost up to $${cap} (the agent's limit); judging is about $0.03 an answer.`);
if (!values.yes && toAsk > 0) {
  console.log("Add --yes to go ahead.");
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
if (!existsSync(runFile)) {
  const meta: RunMeta = {
    name,
    created: new Date().toISOString(),
    agent,
    stamps,
    set: { file: values.set, sha256: set.sha256 },
    runs,
    judge: config.judge.model,
    questions,
  };
  writeFileSync(runFile, JSON.stringify(meta, null, 2) + "\n");
}
const meta = JSON.parse(readFileSync(runFile, "utf8")) as RunMeta;

// 1. Ask.
let asked = 0;
await askAll(agent, meta.questions, meta.runs, dir, Number(values.concurrency), (a) => {
  asked += 1;
  const r = a.reply;
  console.log(`  [${asked}/${toAsk}] ${a.questionId} #${a.k}: ${r ? `${r.status}, $${r.run?.totals?.dollars?.toFixed(3)}, ${r.run?.totals?.seconds}s` : `no reply (${a.error})`}`);
});

// 2 and 3. Check (free) and judge every answer not yet judged.
mkdirSync(join(dir, "verdicts"), { recursive: true });
const todo = loadRun(dir).questions.flatMap((q) =>
  q.answers.filter((a) => !a.judged && a.reply?.answer?.trim()).map((a) => ({ q, a })),
);
if (todo.length > 0) console.log(`Judging ${todo.length} answers…`);
const workers = Array.from({ length: 4 }, async () => {
  for (let job = todo.shift(); job; job = todo.shift()) {
    const { q, a } = job;
    try {
      const judged = await judge(q.question, a.reply!.answer, q.question.date ?? a.reply!.run.today, meta.judge);
      writeFileSync(join(dir, "verdicts", `${q.question.id}-${a.k}.json`), JSON.stringify(judged, null, 2) + "\n");
    } catch (e) {
      console.log(`  ${q.question.id} #${a.k}: not judged (${e instanceof Error ? e.message : String(e)}); run again to retry`);
    }
  }
});
await Promise.all(workers);

// 4 and 5. Score and report.
const { summary: s } = loadRun(dir);
const h = s.headline;
console.log(`\n${name}`);
console.log(`  score ${h ? `${h.mean.toFixed(3)} (95% range ${h.low.toFixed(3)}–${h.high.toFixed(3)})` : "—"} over ${s.judged} judged answers of ${s.answers}`);
console.log(`  strict passes ${s.strictPasses}/${s.answers} · right every time ${s.strictEveryTime}/${s.questions} · confidently wrong ${s.confidentWrong}`);
for (const [check, c] of Object.entries(s.checks)) if (c.pass + c.fail > 0) console.log(`  ${check}: ${c.pass} pass, ${c.fail} fail`);
console.log(`  agent $${s.agentDollars} (median $${s.medianDollars?.toFixed(3)} and ${s.medianSeconds?.toFixed(1)}s an answer) · judge $${s.judgeDollars}`);
console.log(`  report: ${writeReport(config.resultsDir)}`);
