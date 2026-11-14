/**
 * Every setting the agent reads, in one place. Nothing else reads `process.env`.
 *
 * `npm start`, `npm run ask` and `npm run seed` load `.env` with Node's own `--env-file-if-exists`,
 * so there is no dotenv package. Copy `.env.example` to `.env` to change a setting.
 */

function text(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got ${raw}`);
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export const config = {
  /** Where the API listens, and the key a caller must send (none: no key needed). */
  server: {
    host: text("HOST", "127.0.0.1"),
    port: number("PORT", 8787),
    key: text("AGENT_KEY", ""),
  },

  openaiApiKey: text("OPENAI_API_KEY", ""),

  /** The one model for everything. Stamped on every run. */
  model: {
    name: text("MODEL", "gpt-6.1-sol"),
    effort: text("MODEL_EFFORT", "medium"),
    verbosity: text("MODEL_VERBOSITY", "medium"),
    /** How long one model request may take before it is retried. */
    requestSeconds: number("MODEL_REQUEST_SECONDS", 300),
    /**
     * US dollars per million tokens, for the cost figure. Cached input is priced on its own because
     * in a tool loop most of the input is a cache read. Check these against your provider's prices.
     */
    prices: {
      inputPerMillion: number("MODEL_INPUT_USD_PER_MTOK", 2),
      cachedInputPerMillion: number("MODEL_CACHED_INPUT_USD_PER_MTOK", 0.1),
      outputPerMillion: number("MODEL_OUTPUT_USD_PER_MTOK", 10),
    },
  },

  /** The model's tools, as names separated by commas. `none` is the floor: one call, no tools. */
  tools: text("TOOLS", "library"),

  /** When a run must stop: rounds of tool calls, then seconds and dollars for the whole answer. */
  limits: {
    rounds: number("RUN_ROUNDS", 40),
    seconds: number("RUN_SECONDS", 480),
    dollars: number("RUN_DOLLARS", 3),
  },

  library: {
    path: text("LIBRARY", "data/library.db"),
    /** `auto` uses vectors when the library has them; `off` never does. */
    embeddings: text("EMBEDDINGS", "off"),
  },

  /** The model that made the library's vectors; a query must be embedded the same way. */
  embedding: {
    model: text("EMBEDDING_MODEL", "text-embedding-3-large"),
    dimensions: number("EMBEDDING_DIMENSIONS", 1024),
    pricePerMillion: number("EMBEDDING_USD_PER_MTOK", 0.13),
  },

  web: {
    firecrawlApiKey: text("FIRECRAWL_API_KEY", ""),
    usdPerCredit: number("FIRECRAWL_USD_PER_CREDIT", 0.0006),
    /** Pages the web tools never read: the official items the test questions were built from. */
    blockList: text("WEB_BLOCK_LIST", "data/blocked.json"),
  },

  /** `on` puts a planted attack page first in the library's search results. */
  plants: flag("PLANTS", false),

  runsDir: text("RUNS_DIR", "runs"),
} as const;
