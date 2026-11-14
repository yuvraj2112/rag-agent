/** A made-up question and reply for the tests: no real question, no real agent, no real judge. */

import type { Answer, AgentReply } from "../src/ask.ts";
import type { Question } from "../src/set.ts";

export const QUESTION: Question = {
  id: "zz-d01",
  type: "T1",
  topic: "Widgets",
  group: "zz-item-1",
  question: "Made-up: is widget income taxable?",
  date: null,
  gold: "Yes: widget income is taxable at 10% under the Widget Tax Act 2020 s 2.",
  points: [
    { id: "zz-d01.1", need: "must", says: "Says widget income is taxable.", accept: ["Says it is income"], quote: "Widget income is taxable" },
    { id: "zz-d01.2", need: "optional", says: "Gives the rate as 10%." },
  ],
  penalties: [{ id: "zz-d01.x1", says: "Says widget income is tax-free." }],
  shared: ["S2", "S4"],
  mustFind: [
    { cite: "Widget Tax Act 2020 s 2", act: "Widget Tax Act 2020", section: "2", url: "https://example.test/widget/#DLM20" },
    { cite: "A ruling", inLibrary: false },
  ],
  answerKeys: ["https://example.test/answer-key/"],
};

export function reply(overrides: Partial<AgentReply> = {}): AgentReply {
  return {
    answer: "As at 11 November 2026, widget income is taxable [extract:L1].",
    status: "answered",
    stopReason: "finished",
    error: null,
    sources: [{ id: "L1", origin: "library", title: "Widget Tax Act 2020", section: "2", url: "https://example.test/widget/#DLM20" }],
    read: [{ id: "L1", origin: "library", title: "Widget Tax Act 2020", section: "2", url: "https://example.test/widget/#DLM20", cited: true }],
    found: [{ id: "P1", kind: "passage", url: "https://example.test/widget/#DLM20", section: "2" }],
    unknownCitations: [],
    run: {
      id: "run-1",
      today: "2026-11-11",
      stamps: { model: { provider: "openai", name: "stand-in" }, tools: [{ name: "passage_search" }], plants: null, web: null },
      totals: { dollars: 0.02, seconds: 12, modelCalls: 3, toolCalls: 2 },
      steps: [{ kind: "tool", name: "passage_search", round: 1, ms: 5, input: { section: "2" }, result: "P1 …" }],
    },
    ...overrides,
  };
}

export const answerOf = (r: AgentReply | null, k = 1): Answer => ({
  questionId: QUESTION.id,
  k,
  askedAt: "2026-11-11T00:00:00Z",
  httpStatus: r ? 200 : null,
  reply: r,
  error: r ? null : "connection refused",
});
