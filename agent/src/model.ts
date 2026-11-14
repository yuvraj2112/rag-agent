/**
 * The model: which one, with what settings, and what its tokens cost.
 *
 * ← To use another provider, change this file. The rest of the agent only sees `chatModel()`,
 * `embeddingModel()` and `providerOptions()`. For example, with `npm i @ai-sdk/anthropic`:
 *
 *     import { anthropic } from "@ai-sdk/anthropic";
 *     export const chatModel = () => anthropic("claude-sonnet-5-5");
 *
 * and set its prices in `.env`. Keep the embedding model as it is: the library's vectors were made
 * with it (`npm run seed -- --fresh` makes them again with another).
 *
 * `store: false` is on every request: the questions are somebody's tax problem, so the provider
 * doesn't save the response for later use. It is not zero retention: the provider may still keep
 * requests for a time (for abuse monitoring, say) under its own terms.
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelUsage } from "ai";

import { config } from "./config.ts";

export const PROVIDER = "openai";

let provider: ReturnType<typeof createOpenAI> | undefined;

function openai() {
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is not set (see .env.example)");
  provider ??= createOpenAI({
    apiKey: config.openaiApiKey,
    fetch: fetchWithin(config.model.requestSeconds),
  });
  return provider;
}

export const chatModel = (name: string = config.model.name) => openai()(name);

export const embeddingModel = () => openai().embeddingModel(config.embedding.model);

export function providerOptions() {
  return {
    openai: {
      store: false,
      reasoningEffort: config.model.effort,
      textVerbosity: config.model.verbosity,
    },
  };
}

export const embeddingOptions = () => ({
  openai: { dimensions: config.embedding.dimensions },
});

export interface Prices {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

export interface Tokens {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

/** `input` counts every input token, cached or not; `reasoning` is part of `output`. */
export function tokensOf(usage: LanguageModelUsage): Tokens {
  return {
    input: usage.inputTokens ?? 0,
    cachedInput: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    output: usage.outputTokens ?? 0,
    reasoning: usage.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

/** What one call cost. Cached input is taken out of the input count and priced on its own. */
export function dollarsFor(tokens: Tokens, prices: Prices = config.model.prices): number {
  const fresh = Math.max(tokens.input - tokens.cachedInput, 0);
  return (
    (fresh * prices.inputPerMillion +
      tokens.cachedInput * prices.cachedInputPerMillion +
      tokens.output * prices.outputPerMillion) /
    1_000_000
  );
}

/**
 * A fetch that gives up on a request left without a reply, as the network error the AI SDK
 * retries. (An abort would not be retried: the SDK reads that as the caller giving up.)
 */
export function fetchWithin(seconds: number, base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(new Error(`no reply within ${seconds} s`)), seconds * 1000);
    const caller = init?.signal ?? undefined;
    const signal = caller ? AbortSignal.any([caller, giveUp.signal]) : giveUp.signal;
    try {
      return await base(input, { ...init, signal });
    } catch (error) {
      if (giveUp.signal.aborted && !caller?.aborted) {
        throw new TypeError("fetch failed", { cause: giveUp.signal.reason });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
