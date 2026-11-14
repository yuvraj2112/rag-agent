/**
 * The tools the model may call, all in one place. `TOOLS` picks which a run has: `none` (the
 * floor), `library` (the three library tools) or `library,web` (all five).
 *
 * ← To add a tool: write its work in a file beside this one, add it to `all` below with a
 * description and an input schema, and add its name to TOOL_NAMES. It gets the library (and its
 * read-only `db`) through `context`.
 *
 * The tools are made per answer, around that answer's id book: the model sees only short ids
 * (D1, P1, L1, W1…), and every result is text, a refusal included.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import type { Library } from "../library.ts";
import type { IdBook } from "./ids.ts";
import { Refusal, read, searchDocuments, searchPassages } from "./library.ts";
import { readWeb, searchWeb, type WebContext } from "./web.ts";

export const TOOL_NAMES = ["library_search", "passage_search", "library_read", "web_search", "web_read"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export const WEB_TOOLS: readonly ToolName[] = ["web_search", "web_read"];

export interface ToolContext {
  library: Library;
  book: IdBook;
  /** The web tools' settings, caps and log for this answer; null without them. */
  web: WebContext | null;
}

/** `TOOLS` as tool names: `library` and `web` stand for their tools. An unknown name stops the start. */
export function toolNames(setting: string): ToolName[] {
  const names = setting
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name && name !== "none")
    .flatMap((name): string[] =>
      name === "library" ? ["library_search", "passage_search", "library_read"] : name === "web" ? [...WEB_TOOLS] : [name],
    );
  const unknown = names.filter((name) => !(TOOL_NAMES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(`TOOLS has unknown names (${unknown.join(", ")}); use none, library, web or: ${TOOL_NAMES.join(", ")}`);
  }
  return [...new Set(names)] as ToolName[];
}

/** Run one tool call, and turn a refusal into the answer the model reads. Other failures are thrown. */
async function call(work: () => Promise<string>): Promise<string> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Refusal) return error.message;
    throw error;
  }
}

const PAGE = z.number().int().min(1).optional().describe("Which page of results. Defaults to 1.");

export function toolsFor(names: readonly ToolName[], context: ToolContext): ToolSet {
  const { library, book } = context;

  // Each tool is sent with strict off: strict mode makes the model fill every input of every call.
  const all = {
    library_search: tool({
      strict: false,
      description:
        'Find Acts in the library by their title and summary. Give at least one of query or words. query finds Acts by what they cover; describe the Act as its title or summary would, not in the words of the question. words keeps only Acts whose title or summary contains those words in order; use it for a name, such as "Income Tax Act 2007". Returns up to 10 Acts a page, each with an id (D1, D2…), title, version date and the start of its summary. It returns no text of the law, and nothing here can be cited. Search inside an Act with passage_search, or open its outline with library_read.',
      inputSchema: z
        .object({
          query: z.string().min(1).optional().describe('What the Act is about, as its title or summary would put it. Example: "goods and services tax".'),
          words: z.string().min(1).optional().describe('Words that must appear, in this order, in the title or summary, such as "Income Tax Act 2007".'),
          page: PAGE,
        })
        .strict(),
      execute: (input) => call(() => searchDocuments(library, book, input)),
    }),

    passage_search: tool({
      strict: false,
      description: "Search the text of the library's Acts, section by section. Give at least one of query, words or section. query finds the passages that best match it; write it in the words the law itself would use, not the words of the question. words keeps only passages that contain those words in order, in the text or in the section's heading. section keeps only sections with that code, such as CB 6 or 14. Narrow any search with in when you know the Act. Returns up to 10 passages a page, each with an id (P1, P2…), its Act, section, dates and the first 300 characters. A passage found here can't be cited: open it with library_read first.",
      inputSchema: z
        .object({
          query: z.string().min(1).optional().describe('What the passage says, in the law\'s words. Example: "a loan made to an employee is a fringe benefit".'),
          words: z.string().min(1).optional().describe('Words that must appear, in this order, in the passage or its section\'s heading, such as "employment-related loan".'),
          section: z.string().min(1).optional().describe('A section\'s code, exactly as the law numbers it, such as "CX 10" or "14".'),
          in: z.array(z.string()).min(1).max(5).optional().describe("Up to 5 Act ids from library_search. Only passages from these Acts."),
          page: PAGE,
        })
        .strict(),
      execute: (input) => call(() => searchPassages(library, book, input)),
    }),

    library_read: tool({
      strict: false,
      description:
        "Read the library's text in full, by an id from a search. A passage id (P1…) returns the whole section the passage sits in. An Act's id (D1…) returns its outline: each section with an id to read it by. Long results come in pages. The text comes back as extracts (L1, L2…), one for each part of a section; cite only extracts you have read, as [extract:L1]. Each section comes with the Act's version date, the dates it was amended, and the next and previous sections, each with an id you can read. If your answer is for a date other than today, give it as answerDate, and the result warns you when the section changed after it.",
      inputSchema: z
        .object({
          id: z.string().min(1).describe("A passage from passage_search, an Act from library_search, or an id a read gave you."),
          answerDate: z.string().optional().describe("The date your answer is for, if not today, as YYYY-MM-DD. Used only to warn."),
          page: z.number().int().min(1).optional().describe("Which page of a long result."),
        })
        .strict(),
      execute: (input) => call(() => read(library, book, input)),
    }),

    web_search: tool({
      strict: false,
      description:
        'Search the web for law and official guidance the library lacks. By default it searches only New Zealand\'s official sites: legislation, Inland Revenue and the courts. Set scope to "wider" only after an official search in this answer came back empty. Returns up to 10 results, each with a title, link, snippet and the kind of site. A result can\'t be cited: open it with web_read first.',
      inputSchema: z
        .object({
          query: z.string().min(1).max(500).describe('Words the page would contain, such as "FBT prescribed rate of interest".'),
          scope: z.enum(["official", "wider"]).optional().describe("Defaults to official."),
        })
        .strict(),
      execute: (input, { abortSignal }) =>
        call(() =>
          searchWeb(
            webOf(context),
            book,
            { query: input.query, scope: input.scope ?? "official" },
            abortSignal ?? new AbortController().signal,
          ),
        ),
    }),

    web_read: tool({
      strict: false,
      description:
        "Read a web page or PDF. Only links that appeared in this answer can be read: in search results, in the question, or on a page you have already read. The text comes back as extracts (W1, W2…), to cite as [extract:W1], with the page's own links, which you may read next.",
      inputSchema: z
        .object({
          url: z.string().min(1).describe("The link, exactly as it appeared."),
          page: z.number().int().min(1).optional().describe("For a long page."),
        })
        .strict(),
      execute: (input, { abortSignal }) =>
        call(() => readWeb(webOf(context), book, input, abortSignal ?? new AbortController().signal)),
    }),
  };
  return Object.fromEntries(names.map((name) => [name, all[name]]));
}

function webOf(context: ToolContext): WebContext {
  if (!context.web) throw new Error("the web tools were made without their settings");
  return context.web;
}
