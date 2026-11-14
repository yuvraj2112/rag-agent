/**
 * Download an Act from legislation.govt.nz and save its sections for `npm run seed`.
 *
 *     npm run fetch-law -- 2007/97        (year/number, as in the Act's link)
 *
 * Writes `data/law/<year>-<number>.jsonl.gz`: the Act on the first line, then one line per section,
 * long sections in parts. NZ Acts carry no copyright (Copyright Act 1994, s 27), no key is needed,
 * and the site's robots.txt allows this. Each download is the Act's latest version.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { parse, type HTMLElement, type Node } from "node-html-parser";

export interface ActLine {
  type: "act";
  id: string;
  title: string;
  summary: string;
  asAt: string;
  url: string;
}

export interface SectionLine {
  type: "section";
  /** The provision's own id on legislation.govt.nz, as in its link; a part adds `.2`, `.3`… */
  id: string;
  /** The section's place in the Act, for next and previous; its parts share it. */
  order: number;
  section: string;
  heading: string;
  part: number;
  parts: number;
  /** Each amendment the Act's history notes give, oldest first. */
  changes: { date: string; kind: string; by: string }[];
  url: string;
  text: string;
}

/** A section longer than this is stored in parts, cut between paragraphs. */
const PART_CHARS = 6_000;

const BLOCKS = new Set(["para", "subprov", "label-para", "def-para", "row", "heading", "prov.body"]);
const SKIPPED = new Set(["notes", "history", "history-note", "editorial-note"]);
const MONTHS = "January February March April May June July August September October November December".split(" ");

const tagOf = (node: Node) => ((node as HTMLElement).rawTagName ?? "").toLowerCase();
const childNamed = (el: HTMLElement, tag: string) =>
  el.childNodes.find((c) => tagOf(c) === tag) as HTMLElement | undefined;

function tidy(text: string): string {
  return text
    .replace(/^(\([^)\s]+\))\s*\n+/gm, "$1 ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** A provision's text: sub-labels in brackets, paragraphs on their own lines, notes left out. */
function render(node: Node, parentTag = ""): string {
  if (node.nodeType === 3) return node.text;
  const tag = tagOf(node);
  if (SKIPPED.has(tag)) return "";
  const inner = node.childNodes.map((child) => render(child, tag)).join("");
  if (tag === "label") {
    const label = inner.trim();
    return parentTag === "subprov" || parentTag === "label-para" ? `(${label}) ` : `${label} `;
  }
  if ((node as HTMLElement).getAttribute?.("deletion-status") === "repealed") {
    const label = childNamed(node as HTMLElement, "label");
    return `\n${label ? render(label, tag) : ""}[Repealed]\n`;
  }
  if (tag === "entry") return `${inner.trim()} | `;
  return BLOCKS.has(tag) ? `\n${inner}\n` : inner;
}

/** "1 April 1995" → "1995-04-01". */
function isoDate(text: string): string | null {
  const m = /(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})/.exec(text);
  const month = m ? MONTHS.indexOf(m[2]!) + 1 : 0;
  return m && month ? `${m[3]}-${String(month).padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : null;
}

function changesOf(prov: HTMLElement): SectionLine["changes"] {
  return prov
    .querySelectorAll("history-note")
    .map((note) => ({
      date: isoDate(note.querySelector("amendment-date")?.text ?? "") ?? "",
      kind: tidy(note.querySelector("amending-operation")?.text ?? "amended"),
      by: tidy(note.querySelector("amending-leg")?.text ?? ""),
    }))
    .filter((c) => c.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Cut a long text into parts of about `size` characters, between lines where it can. */
export function partsOf(text: string, size = PART_CHARS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n", size);
    const at = cut > size / 2 ? cut : size;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  parts.push(rest);
  return parts;
}

/** Read an Act's XML into its first line and its sections. */
export function parseAct(xml: string, url: string, id: string): [ActLine, ...SectionLine[]] {
  const root = parse(xml, { comment: false });
  const act = root.querySelector("act");
  if (!act) throw new Error("no <act> in this XML");
  const title = tidy(root.querySelector("title")?.text ?? id);
  const summary = tidy(root.querySelector("long-title")?.text ?? "");
  const head: ActLine = { type: "act", id, title, summary, asAt: act.getAttribute("date.as.at") ?? "", url };

  const lines: SectionLine[] = [];
  let order = 0;
  for (const prov of root.querySelectorAll("prov")) {
    const label = childNamed(prov, "label");
    // Provisions quoted inside other provisions (amendments) are not sections of this Act.
    if (!label || prov.parentNode?.closest("prov")) continue;
    const schedule = prov.closest("schedule");
    const code = tidy(label.text);
    const section = schedule
      ? `Schedule ${tidy(childNamed(schedule, "label")?.text ?? "")} clause ${code}`
      : code;
    const body = childNamed(prov, "prov.body");
    const text = tidy(body ? render(body) : "");
    const anchor = prov.getAttribute("id") ?? `${id}-${order}`;
    const parts = partsOf(text || "(no text)");
    order += 1;
    parts.forEach((part, i) =>
      lines.push({
        type: "section",
        id: i === 0 ? anchor : `${anchor}.${i + 1}`,
        order,
        section,
        heading: tidy(childNamed(prov, "heading")?.text ?? ""),
        part: i + 1,
        parts: parts.length,
        changes: i === 0 ? changesOf(prov) : [],
        url: `${url}/#${anchor}`,
        text: part,
      }),
    );
  }
  return [head, ...lines];
}

/** Download an Act's latest version into `<dir>/<year>-<number>.jsonl.gz`, and say what was saved. */
export async function downloadAct(year: string, number: string, dir = "data/law"): Promise<string> {
  const url = `https://www.legislation.govt.nz/act/public/${year}/${number}/en/latest`;
  const response = await fetch(`${url}.xml`, { headers: { "user-agent": "rag-agent fetch-law" } });
  if (!response.ok) throw new Error(`${url}.xml: HTTP ${response.status}`);
  const lines = parseAct(await response.text(), url, `act_public_${year}_${number}`);
  const file = join(dir, `${year}-${number}.jsonl.gz`);
  writeFileSync(file, gzipSync(lines.map((line) => JSON.stringify(line)).join("\n") + "\n"));
  return `${lines[0].title} (as at ${lines[0].asAt}): ${lines.length - 1} passages → ${file}`;
}

if (import.meta.main) {
  const match = /^(\d{4})\/(\d+)$/.exec(process.argv[2] ?? "");
  if (!match) {
    console.error("usage: npm run fetch-law -- <year>/<number>   e.g. 2007/97 for the Income Tax Act 2007");
    process.exit(1);
  }
  console.log(await downloadAct(match[1]!, match[2]!));
}
