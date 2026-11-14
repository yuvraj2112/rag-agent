/**
 * Asking the agent. All the harness knows about it is this contract:
 *
 *     GET  /health  →  { stamps }          what is about to be tested
 *     POST /ask     { question, country }  →  the agent's reply (see AgentReply)
 *
 * Any agent that speaks it can be tested. Each answer is saved as its own file the moment it
 * arrives, and an answer already saved is never asked for again.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.ts";
import type { Question } from "./set.ts";

export interface Source {
  id: string;
  origin: "library" | "web";
  title: string;
  section: string | null;
  url?: string;
}

/** The reply fields the harness reads. An agent may send more. */
export interface AgentReply {
  answer: string;
  status: "answered" | "stopped" | "failed";
  stopReason: string;
  error: string | null;
  sources: Source[];
  read: (Source & { cited: boolean })[];
  found: { id: string; kind: string; url: string | null; section: string | null }[];
  unknownCitations: string[];
  run: {
    id: string;
    today: string;
    stamps: Record<string, unknown>;
    totals: { dollars: number; seconds: number; modelCalls: number; toolCalls: number };
    steps: { kind: string; name: string; round: number; ms: number | null; input?: unknown; result?: string; error?: string; dollars?: number }[];
    record?: string;
  };
}

export interface Answer {
  questionId: string;
  k: number;
  askedAt: string;
  httpStatus: number | null;
  reply: AgentReply | null;
  /** Why there is no reply (a network error, or a body that wasn't JSON). */
  error: string | null;
}

const headers = () => ({
  "content-type": "application/json",
  ...(config.agentKey ? { authorization: `Bearer ${config.agentKey}` } : {}),
});

/** The agent's stamps, or why it can't be reached. */
export async function health(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/health`, { headers: headers() }).catch((e: unknown) => {
    throw new Error(`no agent at ${url} (${e instanceof Error ? e.message : String(e)}): start it with npm start in agent/`);
  });
  if (!res.ok) throw new Error(`${url}/health answered ${res.status}`);
  return ((await res.json()) as { stamps: Record<string, unknown> }).stamps;
}

export const answerFile = (dir: string, id: string, k: number) => join(dir, "answers", `${id}-${k}.json`);

/** Saved and usable: a reply that didn't fail. A failed or missing one is asked again. */
export function savedAnswer(dir: string, id: string, k: number): Answer | null {
  const path = answerFile(dir, id, k);
  if (!existsSync(path)) return null;
  const saved = JSON.parse(readFileSync(path, "utf8")) as Answer;
  return saved.reply && saved.reply.status !== "failed" ? saved : null;
}

async function askOne(url: string, q: Question, k: number): Promise<Answer> {
  const askedAt = new Date().toISOString();
  try {
    const res = await fetch(`${url}/ask`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ question: q.question, country: "nz" }),
    });
    const body = await res.text();
    try {
      return { questionId: q.id, k, askedAt, httpStatus: res.status, reply: JSON.parse(body) as AgentReply, error: null };
    } catch {
      return { questionId: q.id, k, askedAt, httpStatus: res.status, reply: null, error: body.slice(0, 500) };
    }
  } catch (e) {
    return { questionId: q.id, k, askedAt, httpStatus: null, reply: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Ask every question `runs` times, `concurrency` at once, skipping answers already saved. */
export async function askAll(
  url: string,
  questions: Question[],
  runs: number,
  dir: string,
  concurrency = 5,
  onDone: (a: Answer) => void = () => {},
): Promise<void> {
  mkdirSync(join(dir, "answers"), { recursive: true });
  const todo = questions.flatMap((q) =>
    Array.from({ length: runs }, (_, i) => ({ q, k: i + 1 })).filter(({ q, k }) => !savedAnswer(dir, q.id, k)),
  );
  const worker = async () => {
    for (let job = todo.shift(); job; job = todo.shift()) {
      const answer = await askOne(url, job.q, job.k);
      writeFileSync(answerFile(dir, job.q.id, job.k), JSON.stringify(answer, null, 2) + "\n");
      onDone(answer);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}
