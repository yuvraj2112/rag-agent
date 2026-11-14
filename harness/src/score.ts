/**
 * Scores, worked out from the saved files only, so a run can be scored again for free.
 *
 * - **Answer score** = (weights of points met + weights of penalties hit) ÷ weights of all positive
 *   points. Penalties are −3 and not clipped, so a confidently wrong answer can score below 0. An
 *   empty or failed answer scores 0.
 * - **Question score** = the mean of its answers. **Headline** = the mean over questions, with a
 *   95% range from the bootstrap in stats.ts.
 * - **Strict pass** = every must point met and no penalty hit.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Answer } from "./ask.ts";
import { checksFor, CHECKS, type Check } from "./checks.ts";
import type { Judged } from "./judge.ts";
import { gradables, type Question } from "./set.ts";
import { bootstrap, grouped, median } from "./stats.ts";

/** What `run.json` holds: the questions are copied in, so a later edit to the set can't change this run. */
export interface RunMeta {
  name: string;
  created: string;
  agent: string;
  stamps: Record<string, unknown>;
  set: { file: string; sha256: string };
  runs: number;
  judge: string;
  questions: Question[];
}

export interface ScoredAnswer extends Omit<Answer, "questionId"> {
  checks: Check[];
  judged: Judged | null;
  score: number | null;
  strict: boolean | null;
  confidentWrong: boolean | null;
}

export interface ScoredQuestion {
  question: Question;
  answers: ScoredAnswer[];
  score: number | null;
}

export interface RunView {
  meta: RunMeta;
  questions: ScoredQuestion[];
  summary: ReturnType<typeof summarise>;
}

export function scoreAnswer(q: Question, judged: Judged | null, empty: boolean) {
  const all = gradables(q);
  if (empty) return { score: 0, strict: false, confidentWrong: false };
  if (!judged) return { score: null, strict: null, confidentWrong: null };
  const met = new Set(judged.verdicts.filter((v) => v.verdict === "yes").map((v) => v.id));
  const positive = all.filter((g) => g.kind !== "penalty").reduce((sum, g) => sum + g.weight, 0);
  const got = all.filter((g) => met.has(g.id)).reduce((sum, g) => sum + g.weight, 0);
  const penaltyHit = all.some((g) => g.kind === "penalty" && met.has(g.id));
  return {
    score: positive > 0 ? got / positive : null,
    strict: all.every((g) => g.need !== "must" || met.has(g.id)) && !penaltyHit,
    confidentWrong: penaltyHit,
  };
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export function loadRun(dir: string): RunView {
  const meta = readJson<RunMeta>(join(dir, "run.json"));
  const questions = meta.questions.map((question): ScoredQuestion => {
    const answers: ScoredAnswer[] = [];
    for (let k = 1; k <= meta.runs; k++) {
      const file = join(dir, "answers", `${question.id}-${k}.json`);
      if (!existsSync(file)) continue;
      const { questionId: _id, ...answer } = readJson<Answer>(file);
      const verdicts = join(dir, "verdicts", `${question.id}-${k}.json`);
      const judged = existsSync(verdicts) ? readJson<Judged>(verdicts) : null;
      const empty = !answer.reply?.answer?.trim();
      answers.push({ ...answer, checks: checksFor(question, { questionId: question.id, ...answer }), judged, ...scoreAnswer(question, judged, empty) });
    }
    const scores = answers.map((a) => a.score).filter((s): s is number => s !== null);
    return { question, answers, score: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null };
  });
  return { meta, questions, summary: summarise(questions) };
}

export function summarise(questions: ScoredQuestion[]) {
  const answers = questions.flatMap((q) => q.answers);
  const scored = Object.fromEntries(questions.filter((q) => q.score !== null).map((q) => [q.question.id, q.score!]));
  const groupOf = Object.fromEntries(questions.map((q) => [q.question.id, q.question.group]));
  const dollars = answers.map((a) => a.reply?.run?.totals?.dollars ?? 0);
  const checks = Object.fromEntries(
    CHECKS.map((name) => {
      const results = answers.map((a) => a.checks.find((c) => c.name === name)?.pass ?? null);
      return [name, { pass: results.filter((r) => r === true).length, fail: results.filter((r) => r === false).length }];
    }),
  );
  return {
    questions: questions.length,
    answers: answers.length,
    judged: answers.filter((a) => a.score !== null).length,
    headline: bootstrap(grouped(scored, groupOf)),
    strictPasses: answers.filter((a) => a.strict).length,
    /** Questions where every answer passed strictly: the agent gets it right every time. */
    strictEveryTime: questions.filter((q) => q.answers.length > 0 && q.answers.every((a) => a.strict)).length,
    confidentWrong: answers.filter((a) => a.confidentWrong).length,
    checks,
    agentDollars: Number(dollars.reduce((a, b) => a + b, 0).toFixed(4)),
    medianDollars: median(dollars),
    medianSeconds: median(answers.map((a) => a.reply?.run?.totals?.seconds ?? 0)),
    judgeDollars: Number(answers.reduce((sum, a) => sum + (a.judged?.dollars ?? 0), 0).toFixed(4)),
  };
}

/** Every run saved under the results folder, oldest first. */
export function loadRuns(resultsDir: string): RunView[] {
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(resultsDir, d.name, "run.json")))
    .map((d) => loadRun(join(resultsDir, d.name)))
    .sort((a, b) => a.meta.created.localeCompare(b.meta.created));
}
