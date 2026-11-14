/**
 * The web tools (off by default; `TOOLS=library,web` turns them on). `web_search` searches through
 * Firecrawl, official sites first. `web_read` reads a link the answer has seen, directly when it can
 * and through Firecrawl when that fails or the page is thin. Every call is logged with its fee, and
 * every refused or blocked link with the reason.
 *
 * Safety: only http(s) on the usual ports, no logins in links, public addresses only (checked again
 * after every redirect), the site's robots.txt, size caps, and a block list of answer-key pages.
 */

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { BlockList as AddressList, isIP } from "node:net";

import { parse as parseHtml } from "node-html-parser";
import robotsModule from "robots-parser";
import { extractText } from "unpdf";

import { config } from "../config.ts";
import { linksIn, normalLink, type IdBook, type WebPart } from "./ids.ts";
import { Refusal, SIZES, SOURCE_LINE } from "./library.ts";

/** Caps and sizes, stamped. */
export const WEB = {
  searchesPerAnswer: 10,
  pagesPerAnswer: 20,
  results: 10,
  thinChars: 500,
  seconds: 20,
  redirects: 5,
  pageBytes: 4 * 1024 * 1024,
  pdfBytes: 20 * 1024 * 1024,
  scannedPages: 50,
  linksShown: 40,
} as const;

/** New Zealand's official sites. Plain ASCII only, so a look-alike letter can't pass. */
export const OFFICIAL_SITES: readonly string[] = ["govt.nz", "nzlii.org"];

export type SiteKind = "official law" | "tax authority" | "court" | "government" | "other";

/** The kind of site a host is, by its first matching suffix. */
const SITE_KINDS: readonly [string, SiteKind][] = [
  ["legislation.govt.nz", "official law"],
  ["ird.govt.nz", "tax authority"],
  ["courtsofnz.govt.nz", "court"],
  ["justice.govt.nz", "court"],
  ["nzlii.org", "court"],
  ["govt.nz", "government"],
];

const FIRECRAWL = "https://api.firecrawl.dev/v2";
const USER_AGENT = "Mozilla/5.0 (compatible; rag-agent/1.0; tax research)";
const ROBOT = "rag-agent";
// Its types describe an ES default export, but the package is CommonJS: the default import is the function.
const robotsParser = robotsModule as unknown as typeof robotsModule.default;

/**
 * The answer-key block list (`WEB_BLOCK_LIST`): domains, link prefixes, and link patterns (regular
 * expressions, any case). A test question built from an official page must not be answered by
 * reading that page.
 */
export interface BlockedSites {
  domains: string[];
  urls: string[];
  patterns?: string[];
}

/** What one web call did, for the run record. */
export interface WebLogEntry {
  tool: "web_search" | "web_read";
  at: string;
  query?: string;
  scope?: string;
  url?: string;
  finalUrl?: string;
  how?: "direct" | "firecrawl" | "copy";
  results?: number;
  credits: number;
  dollars: number;
  refused?: string;
  blocked?: string[];
}

/** A page as read, before it is cut into extracts. */
export interface WebPage {
  url: string;
  title: string;
  how: "direct" | "firecrawl";
  fetchedAt: string;
  sections: { heading: string | null; text: string }[];
  links: { label: string; url: string }[];
}

/** The settings the web tools run with, read once; stamped. */
export interface WebSettings {
  apiKey: string;
  usdPerCredit: number;
  blockList: BlockedSites;
  blockListSha256: string;
}

/** What one answer's web tools share. */
export interface WebContext {
  settings: WebSettings;
  used: {
    searches: number;
    pages: number;
    officialEmpty: boolean;
    credits: number;
    dollars: number;
  };
  log: WebLogEntry[];
  /** Pages already read in this answer, by link: a later page of one comes from this copy. */
  pages: Map<string, WebPage>;
  fetch?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  robots?: Map<string, Promise<(url: string) => boolean>>;
}

export function newWebContext(settings: WebSettings): WebContext {
  return {
    settings,
    used: { searches: 0, pages: 0, officialEmpty: false, credits: 0, dollars: 0 },
    log: [],
    pages: new Map(),
  };
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

let loaded: WebSettings | null = null;

/** The web settings and the block list; a missing or broken list stops the start. */
export function webSettings(): WebSettings {
  if (loaded) return loaded;
  const text = readFileSync(config.web.blockList, "utf8");
  const blockList = JSON.parse(text) as BlockedSites;
  if (!Array.isArray(blockList.domains) || !Array.isArray(blockList.urls))
    throw new Error(`${config.web.blockList} must hold "domains" and "urls" lists`);
  for (const pattern of blockList.patterns ?? []) new RegExp(pattern, "i");
  loaded = {
    apiKey: config.web.firecrawlApiKey,
    usdPerCredit: config.web.usdPerCredit,
    blockList,
    blockListSha256: fingerprint(text),
  };
  return loaded;
}

/** Names that can never be real sites (RFC 2606, 6761). */
export function isReserved(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return (
    /\.(example|invalid|test|localhost)$/.test(h) ||
    ["example", "invalid", "test", "localhost"].includes(h) ||
    /(^|\.)example\.(com|net|org)$/.test(h)
  );
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

function under(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function siteKind(url: string): SiteKind {
  const host = hostOf(url);
  return SITE_KINDS.find(([suffix]) => under(host, suffix))?.[1] ?? "other";
}

/** Why a link is on the block list, or null. */
export function blockedBy(url: string, list: BlockedSites): string | null {
  const host = hostOf(url);
  const domain = list.domains.find((d) => under(host, d.toLowerCase()));
  if (domain) return `the block list (${domain})`;
  const prefix = list.urls.find((u) => url.startsWith(u));
  if (prefix) return `the block list (${prefix})`;
  return list.patterns?.some((p) => new RegExp(p, "i").test(url)) ? "the block list" : null;
}

const PRIVATE = new AddressList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  PRIVATE.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["64:ff9b::", 96],
] as const)
  PRIVATE.addSubnet(net, prefix, "ipv6");

/** Whether an address is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(address);
  return family !== 0 && !PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
}

async function addresses(context: WebContext, host: string): Promise<string[]> {
  if (isIP(host.replace(/^\[|\]$/g, ""))) return [host.replace(/^\[|\]$/g, "")];
  if (context.resolve) return context.resolve(host);
  return (await lookup(host, { all: true })).map((a) => a.address);
}

/** A direct fetch that failed for a reason Firecrawl may get past (an error status, a time-out). */
class FetchFailed extends Error {}

/** A link on the block list: refused, and the link recorded. */
class Blocked extends Refusal {
  readonly url: string;
  constructor(url: string, by: string) {
    super(`This page can't be read here: it is on ${by}. Use another source.`);
    this.url = url;
  }
}

const ROBOTS = new Map<string, Promise<(url: string) => boolean>>();

/**
 * Robots.txt for the link's site (RFC 9309): missing (4xx) allows all, unreachable allows none.
 * A site's rules are kept for the process; an unreachable file is tried again next time.
 */
async function robotsAllow(context: WebContext, url: URL, signal: AbortSignal): Promise<boolean> {
  const cache = context.robots ?? ROBOTS;
  let rules = cache.get(url.origin);
  if (!rules) {
    const load = async () => {
      const { response } = await safeFetch(context, new URL("/robots.txt", url), signal, false);
      if (response.status >= 400 && response.status < 500) {
        await response.body?.cancel();
        return () => true;
      }
      if (!response.ok) throw new FetchFailed(`robots.txt ${response.status}`);
      const text = Buffer.from(await bodyOf(response, 512 * 1024)).toString("utf8");
      const robot = robotsParser(`${url.origin}/robots.txt`, text);
      return (link: string) => robot.isAllowed(link, ROBOT) !== false;
    };
    rules = load().catch(() => {
      cache.delete(url.origin);
      return () => false;
    });
    cache.set(url.origin, rules);
  }
  return (await rules)(url.href);
}

/** The checks every link passes before it is fetched, and again after each redirect. */
async function checkLink(
  context: WebContext,
  url: URL,
  signal: AbortSignal,
  robots: boolean,
): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Refusal(`Only http and https links can be read, not ${url.protocol}`);
  if (url.username || url.password) throw new Refusal("A link with a login in it can't be read.");
  if (url.port && url.port !== "80" && url.port !== "443")
    throw new Refusal(`Only the usual web ports can be read, not ${url.port}.`);
  if (isReserved(url.hostname)) throw new Refusal("This link can't be reached.");
  const blocked = blockedBy(url.href, context.settings.blockList);
  if (blocked) throw new Blocked(url.href, blocked);
  let found: string[];
  try {
    found = await addresses(context, url.hostname);
  } catch {
    throw new FetchFailed(`no address for ${url.hostname}`);
  }
  // shortcut: fetch looks the name up again after this check, so a name that switches to a private
  // address in between (DNS rebinding) gets past it; pin the checked address before opening the web tools to strangers.
  if (found.length === 0 || !found.every(isPublicAddress))
    throw new Refusal("This link points to a private address and can't be read.");
  if (robots && !(await robotsAllow(context, url, signal)))
    throw new Refusal(
      "The site's robots.txt asks robots not to read this page. Use another source.",
    );
}

/** Fetch a link, following at most 5 redirects, each checked again. */
async function safeFetch(
  context: WebContext,
  start: URL,
  signal: AbortSignal,
  robots = true,
): Promise<{ response: Response; finalUrl: URL }> {
  let url = start;
  for (let hop = 0; hop <= WEB.redirects; hop += 1) {
    await checkLink(context, url, signal, robots);
    let response: Response;
    try {
      response = await (context.fetch ?? fetch)(url, {
        redirect: "manual",
        signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/pdf,text/plain,*/*" },
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      throw new FetchFailed(error instanceof Error ? error.message : String(error));
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    return { response, finalUrl: url };
  }
  throw new Refusal(`The link redirects more than ${WEB.redirects} times.`);
}

/** The body, refused past its size limit. */
async function bodyOf(response: Response, limit: number): Promise<Uint8Array> {
  const tooBig = () =>
    new Refusal(`The page is over ${Math.round(limit / 1024 / 1024)} MB and isn't read.`);
  const length = Number(response.headers.get("content-length"));
  if (length > limit) {
    await response.body?.cancel();
    throw tooBig();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return new Uint8Array();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const HEADING = "\u0001";

/** An HTML page's main text, split at its headings, and the links in it. */
export function readHtml(
  html: string,
  base: string,
): Pick<WebPage, "title" | "sections" | "links"> {
  const root = parseHtml(html, { comment: false });
  const title =
    tidy(root.querySelector("title")?.text ?? "") || tidy(root.querySelector("h1")?.text ?? "");
  const main =
    root.querySelector("main") ??
    root.querySelector('[role="main"]') ??
    root.querySelector("article") ??
    root.querySelector("body") ??
    root;
  for (const junk of main.querySelectorAll(
    'script, style, noscript, template, svg, iframe, nav, header, footer, aside, form, button, [hidden], [aria-hidden="true"]',
  ))
    junk.remove();
  const links = new Map<string, string>();
  for (const a of main.querySelectorAll("a[href]")) {
    try {
      const url = normalLink(new URL(a.getAttribute("href") ?? "", base).href);
      if (url && url !== normalLink(base) && !links.has(url))
        links.set(url, tidy(a.text).slice(0, 80) || url);
    } catch {
      // an href that isn't a link
    }
  }
  for (const h of main.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const text = tidy(h.text).replace(/[<>&]/g, " ");
    h.replaceWith(`<p>${HEADING}${text}</p>`);
  }
  const sections: WebPage["sections"] = [];
  let current: WebPage["sections"][number] = { heading: null, text: "" };
  for (const raw of main.structuredText.split("\n")) {
    const line = raw.trimStart();
    if (line.startsWith(HEADING)) {
      if (current.text.trim() || current.heading) sections.push(current);
      current = { heading: line.slice(1).trim() || null, text: "" };
    } else current.text += `${line}\n`;
  }
  sections.push(current);
  return {
    title,
    sections: sections
      .map((s) => ({ heading: s.heading, text: tidy(s.text) }))
      .filter((s) => s.text || s.heading),
    links: [...links].map(([url, label]) => ({ label, url })),
  };
}

/** Firecrawl's markdown, split at its headings, with its links made plain. */
export function readMarkdown(markdown: string): WebPage["sections"] {
  const plain = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const sections: WebPage["sections"] = [];
  let current: WebPage["sections"][number] = { heading: null, text: "" };
  for (const line of plain.split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      if (current.text.trim() || current.heading) sections.push(current);
      current = { heading: heading[1]!.trim(), text: "" };
    } else current.text += `${line}\n`;
  }
  sections.push(current);
  return sections
    .map((s) => ({ heading: s.heading, text: tidy(s.text) }))
    .filter((s) => s.text || s.heading);
}

function textLength(sections: WebPage["sections"]): number {
  return sections.reduce((sum, s) => sum + s.text.length, 0);
}

async function firecrawl<T>(
  context: WebContext,
  path: string,
  body: object,
  signal: AbortSignal,
): Promise<T & { creditsUsed?: number; success?: boolean; error?: string }> {
  const response = await (context.fetch ?? fetch)(`${FIRECRAWL}${path}`, {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${context.settings.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as T & {
    creditsUsed?: number;
    success?: boolean;
    error?: string;
  };
  if (!response.ok || json.success === false)
    throw new FetchFailed(`Firecrawl ${response.status}${json.error ? `: ${json.error}` : ""}`);
  return json;
}

function charge(context: WebContext, entry: WebLogEntry, credits: number): void {
  entry.credits = credits;
  entry.dollars = Number((credits * context.settings.usdPerCredit).toFixed(6));
  context.used.credits += credits;
  context.used.dollars = Number((context.used.dollars + entry.dollars).toFixed(6));
}

/** Read a page through Firecrawl, never from or into its cache. */
async function scrape(
  context: WebContext,
  url: string,
  signal: AbortSignal,
  entry: WebLogEntry,
): Promise<WebPage> {
  interface Scrape {
    data?: {
      markdown?: string;
      links?: string[];
      metadata?: {
        title?: string | string[];
        url?: string;
        statusCode?: number;
        creditsUsed?: number;
      };
    };
  }
  const result = await firecrawl<Scrape>(
    context,
    "/scrape",
    {
      url,
      formats: ["markdown", "links"],
      onlyMainContent: true,
      maxAge: 0,
      storeInCache: false,
      timeout: WEB.seconds * 1000,
      parsers: [{ type: "pdf", maxPages: WEB.scannedPages }],
    },
    signal,
  );
  const meta = result.data?.metadata ?? {};
  charge(context, entry, meta.creditsUsed ?? 1);
  const finalUrl = meta.url ?? url;
  entry.finalUrl = finalUrl;
  const blocked = blockedBy(finalUrl, context.settings.blockList);
  if (blocked) throw new Blocked(finalUrl, blocked);
  if ((meta.statusCode ?? 200) >= 400)
    throw new Refusal(`The page couldn't be read (HTTP ${meta.statusCode}). Try another link.`);
  const title = Array.isArray(meta.title) ? (meta.title[0] ?? "") : (meta.title ?? "");
  return {
    url,
    title: tidy(title),
    how: "firecrawl",
    fetchedAt: new Date().toISOString(),
    sections: readMarkdown(result.data?.markdown ?? ""),
    links: (result.data?.links ?? [])
      .map((link) => normalLink(link))
      .filter((link): link is string => link !== null && link !== normalLink(url))
      .map((link) => ({ label: link, url: link })),
  };
}

/** Read a page: directly first, then through Firecrawl if that fails or the page is thin. */
async function fetchPage(
  context: WebContext,
  url: string,
  signal: AbortSignal,
  entry: WebLogEntry,
): Promise<WebPage> {
  let known: { scanned: boolean; pages: number } | null = null;
  try {
    const { response, finalUrl } = await safeFetch(context, new URL(url), signal);
    entry.finalUrl = finalUrl.href;
    if (!response.ok) {
      await response.body?.cancel();
      throw new FetchFailed(`HTTP ${response.status}`);
    }
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    const pdf = type.includes("application/pdf") || /\.pdf$/i.test(finalUrl.pathname);
    const bytes = await bodyOf(response, pdf ? WEB.pdfBytes : WEB.pageBytes);
    const fetchedAt = new Date().toISOString();
    if (pdf || Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-") {
      const { totalPages, text } = await extractText(new Uint8Array(bytes), { mergePages: false });
      const sections = text.map((page, i) => ({ heading: `Page ${i + 1}`, text: tidy(page) }));
      if (textLength(sections) >= WEB.thinChars) {
        return {
          url,
          title: decodeURIComponent(finalUrl.pathname.split("/").pop() ?? "") || finalUrl.host,
          how: "direct",
          fetchedAt,
          sections,
          links: linksIn(text.join("\n")).map((link) => ({ label: link, url: link })),
        };
      }
      known = { scanned: true, pages: totalPages };
    } else if (type.includes("html") || type === "") {
      const page = readHtml(Buffer.from(bytes).toString("utf8"), finalUrl.href);
      if (textLength(page.sections) >= WEB.thinChars)
        return { url, how: "direct", fetchedAt, ...page };
    } else if (type.startsWith("text/")) {
      const text = tidy(Buffer.from(bytes).toString("utf8"));
      if (text.length >= WEB.thinChars) {
        return {
          url,
          title: finalUrl.href,
          how: "direct",
          fetchedAt,
          sections: [{ heading: null, text }],
          links: linksIn(text).map((link) => ({ label: link, url: link })),
        };
      }
    }
  } catch (error) {
    if (!(error instanceof FetchFailed)) throw error;
    if (/\.pdf$/i.test(new URL(url).pathname))
      throw new Refusal(
        "This PDF couldn't be opened directly, so its size is unknown and it isn't sent to the paid reader. Try another link.",
      );
  }
  if (known && known.pages > WEB.scannedPages)
    throw new Refusal(
      `This PDF is scanned and has ${known.pages} pages, over the ${WEB.scannedPages}-page limit.`,
    );
  try {
    return await scrape(context, url, signal, entry);
  } catch (error) {
    if (error instanceof FetchFailed)
      throw new Refusal(`The page couldn't be read (${error.message}). Try another link.`);
    throw error;
  }
}

/** One section split to fit a page, at paragraph breaks where it can be. */
function pieces(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n\n", size);
    const at = cut > size / 2 ? cut : size;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** A page's extracts, packed into pages of at most 12,000 characters. */
export function webPages(page: WebPage): WebPart[][] {
  const parts: WebPart[] = page.sections.flatMap((section, s) => {
    const body = section.heading ? `${section.heading}\n${section.text}`.trim() : section.text;
    const split = pieces(body, SIZES.pageChars);
    return split.map((text, p) => ({
      key: `${page.url} ${s} ${p + 1}`,
      url: page.url,
      title: page.title,
      section: section.heading,
      part: p + 1,
      parts: split.length,
      how: page.how,
      site: siteKind(page.url),
      text,
      sha256: createHash("sha256").update(text).digest("hex"),
      fetchedAt: page.fetchedAt,
    }));
  });
  const pages: WebPart[][] = [];
  let current: WebPart[] = [];
  let size = 0;
  for (const part of parts) {
    if (current.length > 0 && size + part.text.length > SIZES.pageChars) {
      pages.push(current);
      current = [];
      size = 0;
    }
    current.push(part);
    size += part.text.length;
  }
  if (current.length > 0 || pages.length === 0) pages.push(current);
  return pages;
}

/** A result's snippet as plain text: Firecrawl's carry markdown headings, tables and links. */
function snippet(text: string): string {
  const flat = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s/g, "$1")
    .replace(/\|?\s*-+\s*\|(\s*-+\s*\|)*/g, " ")
    .replace(/[|*_`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > SIZES.snippetChars ? `${flat.slice(0, SIZES.snippetChars - 1)}…` : flat;
}

/** `web_search`: up to 10 results from official sites (or wider), each a lead to read. */
export async function searchWeb(
  context: WebContext,
  book: IdBook,
  input: { query: string; scope: "official" | "wider" },
  signal: AbortSignal,
): Promise<string> {
  const entry: WebLogEntry = {
    tool: "web_search",
    at: new Date().toISOString(),
    query: input.query,
    scope: input.scope,
    credits: 0,
    dollars: 0,
  };
  context.log.push(entry);
  const refuse = (why: string) => {
    entry.refused = why;
    return why;
  };
  if (input.scope === "wider" && !context.used.officialEmpty)
    return refuse(
      'scope "wider" opens only after an official search in this answer finds nothing. Search official sites first.',
    );
  if (context.used.searches >= WEB.searchesPerAnswer)
    return refuse(
      `Web searches used up (${WEB.searchesPerAnswer} an answer): answer from what you have read.`,
    );
  context.used.searches += 1;

  const official = input.scope === "official";
  interface Search {
    data?: { web?: { url?: string; title?: string; description?: string }[] };
  }
  let found: Search & { creditsUsed?: number };
  try {
    found = await firecrawl<Search>(
      context,
      "/search",
      {
        query: input.query,
        limit: WEB.results,
        country: "NZ",
        ...(official
          ? { includeDomains: OFFICIAL_SITES }
          : { excludeDomains: context.settings.blockList.domains }),
        ignoreInvalidURLs: true,
        timeout: WEB.seconds * 1000,
      },
      signal,
    );
  } catch (error) {
    if (!(error instanceof FetchFailed)) throw error;
    return refuse(`The web search failed (${error.message}). Try again, or use the library.`);
  }
  charge(context, entry, found.creditsUsed ?? 2);

  const blocked: string[] = [];
  const results = (found.data?.web ?? []).filter((r) => {
    const url = r.url && normalLink(r.url);
    if (!url) return false;
    if (blockedBy(url, context.settings.blockList)) {
      blocked.push(url);
      return false;
    }
    return true;
  });
  if (blocked.length > 0) entry.blocked = blocked;
  entry.results = results.length;
  if (official && results.length === 0) context.used.officialEmpty = true;

  const shown = results.slice(0, WEB.results);
  book.seeLinks(shown.map((r) => r.url!));

  const where = official ? "official NZ sites" : "the wider web for NZ";
  const lines = [
    SOURCE_LINE,
    "",
    `Web results for "${input.query}" on ${where}. ${shown.length} results.`,
  ];
  shown.forEach((r, i) => {
    lines.push(
      `${i + 1}  ${tidy(r.title ?? "") || "Untitled"} · ${siteKind(r.url!)} · ${normalLink(r.url!)}`,
    );
    if (r.description) lines.push(`   ${snippet(r.description)}`);
  });
  lines.push(
    "",
    shown.length === 0
      ? `Nothing found on ${where}. Try other words${official ? ', or scope "wider" for the wider web' : ""}.`
      : "Open a result with web_read to read and cite it.",
  );
  return lines.join("\n");
}

/** `web_read`: one page of a link the answer has seen, as extracts W1, W2… */
export async function readWeb(
  context: WebContext,
  book: IdBook,
  input: { url: string; page?: number | undefined },
  signal: AbortSignal,
): Promise<string> {
  const url = normalLink(input.url);
  const entry: WebLogEntry = {
    tool: "web_read",
    at: new Date().toISOString(),
    url: url ?? input.url,
    credits: 0,
    dollars: 0,
  };
  context.log.push(entry);
  const refuse = (why: string) => {
    entry.refused = why;
    return why;
  };
  if (!url || !book.hasLink(url))
    return refuse(
      "This link hasn't appeared in this answer. Read only links from web_search results, the question or a page you have read.",
    );

  let page = context.pages.get(url);
  if (page) entry.how = "copy";
  else {
    if (context.used.pages >= WEB.pagesPerAnswer)
      return refuse(
        `Web pages used up (${WEB.pagesPerAnswer} an answer): answer from what you have read.`,
      );
    context.used.pages += 1;
    try {
      page = await fetchPage(context, url, AbortSignal.any([signal, AbortSignal.timeout(WEB.seconds * 1000)]), entry);
    } catch (error) {
      if (error instanceof Refusal) {
        if (error instanceof Blocked) entry.blocked = [error.url];
        return refuse(error.message);
      }
      if (error instanceof Error && error.name === "TimeoutError")
        return refuse(`The page took over ${WEB.seconds} seconds and was given up. Try another link.`);
      throw error;
    }
    entry.how = page.how;
    context.pages.set(url, page);
  }

  const pages = webPages(page);
  const number = input.page ?? 1;
  if (number > pages.length)
    return refuse(
      `This page has ${pages.length} page${pages.length === 1 ? "" : "s"}; there is no page ${number}.`,
    );
  const parts = pages[number - 1]!;
  const ids = book.addWebRead(parts);
  const shownLinks = page.links.slice(0, WEB.linksShown);
  book.seeLinks([...shownLinks.map((l) => l.url), ...parts.flatMap((p) => linksIn(p.text))]);

  const lines = [
    SOURCE_LINE,
    "",
    `${page.title || url} · ${url} · fetched ${page.fetchedAt.slice(0, 10)} · page ${number} of ${pages.length}`,
  ];
  if (parts.length === 0) lines.push("", "The page has no text to read.");
  parts.forEach((part, i) => {
    const of = part.parts > 1 ? ` (part ${part.part} of ${part.parts} of one section)` : "";
    lines.push("", `[extract:${ids[i]}]${of}`, part.text);
  });
  if (number === 1 && shownLinks.length > 0) {
    lines.push(
      "",
      `Links on this page: ${shownLinks.map((l) => (l.label === l.url ? l.url : `${l.label} ${l.url}`)).join("; ")}` +
        (page.links.length > shownLinks.length
          ? ` (and ${page.links.length - shownLinks.length} more)`
          : ""),
    );
  }
  if (number < pages.length) lines.push("", `More on page ${number + 1}.`);
  return lines.join("\n");
}
