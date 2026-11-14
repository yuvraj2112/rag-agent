/**
 * A question set: one question per line, with its gold answer as points.
 *
 * - **points** are what a good answer must (`must`, weight 3) or may (`optional`, weight 1) say;
 * - **penalties** are wrong things a confident answer might say (weight −3);
 * - **shared** points apply to every answer (weight 1), picked per question: S1 when the date matters;
 * - **mustFind** are the sections a good answer has to find, read and cite;
 * - **answerKeys** are the official pages the question was built from, which the agent must not read.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface Point {
  id: string;
  need: "must" | "optional";
  says: string;
  accept?: string[];
  case?: string;
  quote?: string;
  cite?: string;
}

export interface Question {
  id: string;
  type: string;
  topic: string;
  /** Questions built from the same official item move together in the bootstrap. */
  group: string;
  question: string;
  /** The date the answer is for, when the question sets one; otherwise the agent's today. */
  date: string | null;
  gold: string;
  points: Point[];
  penalties: { id: string; says: string; cite?: string }[];
  shared: string[];
  /** A section in the library has its Act, section and link; anything else is `inLibrary: false`. */
  mustFind: { cite: string; act?: string; section?: string; url?: string; inLibrary?: boolean }[];
  answerKeys: string[];
}

export const SHARED: Record<string, string> = {
  S1: "States the date or tax year it answers for, and the taxpayer and assumptions, where the answer depends on them.",
  S2: "Names a provision or authority for its main conclusions.",
  S4: "Reaches a conclusion, or says why it can't and what is missing.",
};

export const WEIGHTS = { must: 3, optional: 1, shared: 1, penalty: -3 } as const;

export const TYPES: Record<string, string> = {
  T1: "apply the law",
  T2: "calculation",
  T3: "old law walked forward",
  T4: "several years",
  T5: "recently changed",
  T6: "can't answer",
  T7: "attack",
};

/** One thing an answer is graded on, as the judge sees it. */
export interface Gradable {
  id: string;
  kind: "point" | "penalty" | "shared";
  need: "must" | "optional" | null;
  weight: number;
  says: string;
  accept: string[];
  case: string | null;
  quote: string | null;
}

export function gradables(q: Question): Gradable[] {
  return [
    ...q.points.map((p): Gradable => ({
      id: p.id, kind: "point", need: p.need, weight: WEIGHTS[p.need], says: p.says,
      accept: p.accept ?? [], case: p.case ?? null, quote: p.quote ?? null,
    })),
    ...q.penalties.map((x): Gradable => ({
      id: x.id, kind: "penalty", need: null, weight: WEIGHTS.penalty, says: x.says, accept: [], case: null, quote: null,
    })),
    ...q.shared.map((id): Gradable => ({
      id, kind: "shared", need: null, weight: WEIGHTS.shared, says: SHARED[id] ?? id, accept: [], case: null, quote: null,
    })),
  ];
}

export function loadSet(path: string): { questions: Question[]; sha256: string } {
  const text = readFileSync(path, "utf8");
  const questions = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Question);
  return { questions, sha256: createHash("sha256").update(text).digest("hex").slice(0, 16) };
}
