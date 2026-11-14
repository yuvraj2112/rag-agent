/**
 * The loop: the model reads the question, calls whatever tools it has, and writes the answer.
 *
 * The loop is the AI SDK's own: the model is called, the tools it asks for are run and their results
 * sent back, and that repeats until it answers without asking for a tool, or a limit is reached.
 * With no tools (the floor) it runs once: one model call, one answer.
 *
 * Every model call and tool call is written to `steps` as it happens, so a run stopped part way
 * still shows everything it finished.
 */

import {
  generateText,
  isStepCount,
  type LanguageModel,
  type PrepareStepFunction,
  type StepResult,
  type StopCondition,
  type ToolSet,
} from "ai";

import { config } from "./config.ts";
import { dollarsFor, providerOptions, tokensOf, type Tokens } from "./model.ts";
import { instructionsFor, questionMessage, type Country } from "./prompt.ts";
import { SIZES } from "./tools/library.ts";

export const BARREN_NOTE = "Your last three steps found nothing new. Answer from what you have read, or change approach.";
export const BUDGET_NOTE = "Tool budget used up: answer from what you have read.";

/** Only `finished` means the model stopped on its own; `incomplete` means its last reply was cut off or blocked. */
export type StopReason = "finished" | "incomplete" | "round-limit" | "cost-limit" | "time-limit" | "error";

/** One model call or one tool call. */
export interface Step {
  kind: "model" | "tool";
  /** The model's id, or the tool's name. */
  name: string;
  /** The model call it belongs to, from 1. */
  round: number;
  at: string;
  ms: number | null;
  input?: unknown;
  result?: string;
  error?: string;
  tokens?: Tokens;
  dollars?: number;
  finish?: string;
}

export interface ResearchInput {
  question: string;
  country: Country | null;
  today: string;
  model: LanguageModel;
  tools: ToolSet;
  /** Aborted when the run's time is up. */
  signal: AbortSignal;
  /** Filled in as each call ends. */
  steps: Step[];
  limits?: { rounds: number; dollars: number };
  /** How many ids the answer has had so far: steps adding none get BARREN_NOTE, once. */
  progress?: () => number;
  /** Dollars spent outside the model (web fees), counted in the cost limit. */
  otherDollars?: () => number;
}

export async function research({
  question,
  country,
  today,
  model,
  tools,
  signal,
  steps,
  limits = config.limits,
  progress,
  otherDollars,
}: ResearchInput): Promise<{ answer: string; stopReason: StopReason }> {
  const names = Object.keys(tools);
  const hasTools = names.length > 0;
  const spent = (done: readonly StepResult<ToolSet>[]) =>
    done.reduce((sum, step) => sum + dollarsFor(tokensOf(step.usage)), 0) + (otherDollars?.() ?? 0);
  const overBudget: StopCondition<ToolSet> = ({ steps: done }) => spent(done) >= limits.dollars;

  // After the last round of tools, one more call with the tools off, so the model must answer.
  const held = [progress?.() ?? 0];
  let noted = false;
  const prepareStep: PrepareStepFunction<ToolSet> = ({ messages, stepNumber }) => {
    const notes: string[] = [];
    const recent = held.slice(-(SIZES.barrenSteps + 1));
    if (progress && !noted && recent.length > SIZES.barrenSteps && recent[0] === recent.at(-1)) {
      noted = true;
      notes.push(BARREN_NOTE);
    }
    const last = hasTools && stepNumber >= limits.rounds;
    if (last) notes.push(BUDGET_NOTE);
    if (notes.length === 0) return undefined;
    return {
      messages: [...messages, ...notes.map((content) => ({ role: "user" as const, content }))],
      ...(last ? { toolChoice: "none" as const } : {}),
    };
  };

  let round = 0;
  const open = new Map<string, Step>();
  const started = new Map<Step, number>();
  const begin = (step: Step) => {
    steps.push(step);
    started.set(step, performance.now());
    return step;
  };
  const end = (step: Step, fields: Partial<Step>) => {
    Object.assign(step, fields, { ms: Math.round(performance.now() - (started.get(step) ?? 0)) });
  };
  let modelStep: Step | null = null;

  const result = await generateText({
    model,
    instructions: instructionsFor(names, today),
    messages: [{ role: "user", content: questionMessage(question, country) }],
    tools: hasTools ? tools : undefined,
    stopWhen: [isStepCount(limits.rounds + 1), overBudget],
    prepareStep,
    abortSignal: signal,
    providerOptions: providerOptions(),

    onLanguageModelCallStart: (event) => {
      round += 1;
      modelStep = begin({ kind: "model", name: event.modelId, round, at: new Date().toISOString(), ms: null });
    },
    onLanguageModelCallEnd: (event) => {
      if (!modelStep) return;
      const tokens = tokensOf(event.usage);
      end(modelStep, { tokens, dollars: Number(dollarsFor(tokens).toFixed(6)), finish: event.finishReason });
      modelStep = null;
    },
    onToolExecutionStart: (event) => {
      const call = event.toolCall;
      open.set(
        call.toolCallId,
        begin({ kind: "tool", name: call.toolName, round, at: new Date().toISOString(), ms: null, input: call.input }),
      );
    },
    onToolExecutionEnd: (event) => {
      const step = open.get(event.toolCall.toolCallId);
      if (!step) return;
      open.delete(event.toolCall.toolCallId);
      const outcome = event.toolOutput;
      if (outcome.type === "tool-error") {
        end(step, { error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) });
      } else end(step, { result: String(outcome.output) });
    },
    onStepEnd: () => {
      if (progress) held.push(progress());
    },
  });

  // The loop ended on a limit only if the last step was still asking for tools.
  const last = result.steps.at(-1)?.finishReason;
  const stopReason: StopReason =
    last === "tool-calls"
      ? spent(result.steps) >= limits.dollars
        ? "cost-limit"
        : "round-limit"
      : last === "stop"
        ? "finished"
        : "incomplete";
  return { answer: result.text.trim(), stopReason };
}
