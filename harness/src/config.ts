/** Every setting the harness reads, in one place. `npm run eval` loads `.env`. */

const text = (name: string, fallback: string) => process.env[name] || fallback;
const number = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got ${raw}`);
  return value;
};

export const config = {
  /** The key the agent wants, if it was started with AGENT_KEY. */
  agentKey: text("AGENT_KEY", ""),
  /** `provider:model`. Pick a different family from the agent's model, so it doesn't grade its own kind. */
  judge: {
    model: text("JUDGE_MODEL", "anthropic:claude-sonnet-5-5"),
    effort: text("JUDGE_EFFORT", "medium"),
    /** US dollars per million tokens, for the cost line. Check them against your provider's prices. */
    inputPerMillion: number("JUDGE_INPUT_USD_PER_MTOK", 3),
    outputPerMillion: number("JUDGE_OUTPUT_USD_PER_MTOK", 15),
  },
  resultsDir: text("RESULTS_DIR", "results"),
} as const;
