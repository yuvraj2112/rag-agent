/**
 * One run: one question in, one answer out, and a record of everything in between.
 *
 * The run starts the clock (the time limit), gives the loop its tools and a fresh id book, adds up
 * what was used, works out which extracts the answer cites, writes the run record and returns the
 * reply. The reply carries the agent's stamps: everything besides the question that decides an
 * answer, so two runs are only compared when they really ran the same thing.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asSchema, type LanguageModel, type ToolSet } from "ai";

import { research, type Step, type StopReason } from "./agent.ts";
import { config } from "./config.ts";
import { openLibrary, type Library } from "./library.ts";
import { PROVIDER, chatModel } from "./model.ts";
import { promptFor, type Country } from "./prompt.ts";
import { IdBook, linksIn, type HitEntry, type SourceEntry } from "./tools/ids.ts";
import { WEB_TOOLS, toolNames, toolsFor, type ToolName } from "./tools/index.ts";
import { PLANT_MARKER, plantedLibrary } from "./tools/plants.ts";
import { newWebContext, webSettings, type WebLogEntry } from "./tools/web.ts";

export interface Request {
  question: string;
  country: Country | null;
  /** The date the agent treats as today, `YYYY-MM-DD`. */
  today: string;
}

export interface Totals {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Model and web dollars together. */
  dollars: number;
  webDollars: number;
  seconds: number;
}

/** What `POST /ask` and `npm run ask` give back. */
export interface Reply {
  answer: string;
  status: "answered" | "stopped" | "failed";
  stopReason: StopReason;
  error: string | null;
  /** What the answer cites. */
  sources: SourceEntry[];
  /** Everything read, each marked cited or not. */
  read: (SourceEntry & { cited: boolean })[];
  /** Every search hit and pointer the answer was given (D…, P…). */
  found: HitEntry[];
  /** Extract ids the answer cites that the run never gave: it cited something it never read. */
  unknownCitations: string[];
  run: {
    id: string;
    today: string;
    stamps: Stamps;
    totals: Totals;
    /** Each model call and tool call; tool results cut to 600 characters (the record has them whole). */
    steps: Step[];
    web: WebLogEntry[];
    record: string;
  };
}

export interface Stamps {
  agent: string;
  version: string;
  code: { commit: string; dirty: boolean };
  model: { provider: string; name: string; effort: string; verbosity: string; prices: typeof config.model.prices };
  prompt: { sha256: string };
  /** Each tool by name and a fingerprint of its description and inputs: they are prompt text too. */
  tools: { name: string; sha256: string }[];
  library: { fingerprint: string; vectors: boolean; acts: { title: string; asAt: string }[] } | null;
  web: { blockListSha256: string } | null;
  /** The phrase a planted page asks for, when `PLANTS=on`. */
  plants: { marker: string } | null;
  limits: typeof config.limits;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function codeStamp(): Stamps["code"] {
  try {
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).trim();
    return { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src", "package.json") !== "" };
  } catch {
    return { commit: "unknown", dirty: true };
  }
}

export interface Agent {
  library: Library;
  names: ToolName[];
  stamps: Stamps;
}

/** Everything a run needs that doesn't change between questions, from the settings. */
export function setup(library: Library = openLibrary()): Agent {
  const names = toolNames(config.tools);
  const lib = config.plants ? plantedLibrary(library) : library;
  const web = names.some((n) => WEB_TOOLS.includes(n));
  if (web && !config.web.firecrawlApiKey) throw new Error("the web tools need FIRECRAWL_API_KEY");
  // The tools as the model is given them, for their fingerprints; this copy never runs.
  const tools = toolsFor(names, { library: lib, book: new IdBook(), web: null });
  // The model reads a tool's description and its inputs' descriptions, so both go in the fingerprint.
  const description = (t: ToolSet[string]) =>
    (typeof t.description === "string" ? t.description : "") + JSON.stringify(asSchema(t.inputSchema).jsonSchema);
  const stamps: Stamps = {
    agent: "rag-agent",
    version: (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version,
    code: codeStamp(),
    model: { provider: PROVIDER, name: config.model.name, effort: config.model.effort, verbosity: config.model.verbosity, prices: config.model.prices },
    prompt: { sha256: sha(promptFor(names)) },
    tools: Object.entries(tools).map(([name, t]) => ({ name, sha256: sha(description(t)) })),
    library: names.some((n) => !WEB_TOOLS.includes(n)) ? library.info : null,
    web: web ? { blockListSha256: webSettings().blockListSha256 } : null,
    plants: config.plants ? { marker: PLANT_MARKER } : null,
    limits: config.limits,
  };
  return { library: lib, names, stamps };
}

export async function runQuestion(
  request: Request,
  { library, names, stamps }: Agent,
  model: LanguageModel = chatModel(),
): Promise<Reply> {
  const id = randomBytes(8).toString("hex");
  const startedAt = new Date();
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(new Error("time limit")), config.limits.seconds * 1000);

  const steps: Step[] = [];
  const book = new IdBook();
  const web = names.some((n) => WEB_TOOLS.includes(n)) ? newWebContext(webSettings()) : null;
  if (web) book.seeLinks(linksIn(request.question));
  const tools = toolsFor(names, { library, book, web });

  let answer = "";
  let stopReason: StopReason;
  let error: string | null = null;
  try {
    ({ answer, stopReason } = await research({
      question: request.question,
      country: request.country,
      today: request.today,
      model,
      tools,
      signal: clock.signal,
      steps,
      progress: names.length > 0 ? () => book.size : undefined,
      otherDollars: web ? () => web.used.dollars : undefined,
    }));
  } catch (thrown) {
    if (clock.signal.aborted) stopReason = "time-limit";
    else {
      stopReason = "error";
      error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    }
  } finally {
    clearTimeout(timer);
  }

  const sum = (pick: (s: Step) => number | undefined) => steps.reduce((total, s) => total + (pick(s) ?? 0), 0);
  const webDollars = web?.used.dollars ?? 0;
  const totals: Totals = {
    modelCalls: steps.filter((s) => s.kind === "model").length,
    toolCalls: steps.filter((s) => s.kind === "tool").length,
    inputTokens: sum((s) => s.tokens?.input),
    cachedInputTokens: sum((s) => s.tokens?.cachedInput),
    outputTokens: sum((s) => s.tokens?.output),
    reasoningTokens: sum((s) => s.tokens?.reasoning),
    dollars: Number((sum((s) => s.dollars) + webDollars).toFixed(6)),
    webDollars: Number(webDollars.toFixed(6)),
    seconds: Number(((Date.now() - startedAt.getTime()) / 1000).toFixed(1)),
  };
  const citations = book.citations(answer);

  // The record holds everything; it is written once and never edited.
  const folder = join(config.runsDir, request.today);
  mkdirSync(folder, { recursive: true });
  const time = startedAt.toTimeString().slice(0, 8).replace(/:/g, "");
  const record = join(folder, `${time}-${id}.json`);
  const reply: Reply = {
    answer,
    status: stopReason === "finished" ? "answered" : stopReason === "error" ? "failed" : "stopped",
    stopReason,
    error,
    sources: citations.read.filter((s) => s.cited).map(({ cited: _cited, ...s }) => s),
    read: citations.read,
    found: [...book.hits],
    unknownCitations: citations.unknown,
    run: {
      id,
      today: request.today,
      stamps,
      totals,
      steps: steps.map((s) => (s.result && s.result.length > 600 ? { ...s, result: `${s.result.slice(0, 600)}…` } : s)),
      web: web?.log ?? [],
      record,
    },
  };
  writeFileSync(
    record,
    JSON.stringify({ request, startedAt: startedAt.toISOString(), ...reply, run: { ...reply.run, steps }, extracts: book.extracts }, null, 2) + "\n",
    { flag: "wx" },
  );
  return reply;
}
