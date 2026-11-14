/**
 * The id book: one per answer, never shared. The model only ever sees short ids.
 *
 * - Search hits get D1… (Acts) and P1… (passages). They can't be cited; a tool turns them back
 *   into the library's own ids.
 * - What is read gets an extract id, L1… (library) or W1… (web). Only these can be cited, as
 *   `[extract:L4]`. After the last reply, `citations()` turns the answer's citations into the
 *   reply's source lists, and names any id the book never gave: a cited source the agent never read.
 */

export interface LibraryExtract {
  id: string;
  origin: "library";
  passageId: string;
  documentId: string;
  title: string;
  section: string;
  part: number;
  parts: number;
  /** The Act's version date. */
  date: string;
  /** The section's link, so a checker can match it to a gold's source. */
  url: string;
  text: string;
  sha256: string;
  fetchedAt: string;
}

export interface WebExtract {
  id: string;
  origin: "web";
  url: string;
  title: string;
  section: string | null;
  part: number;
  parts: number;
  how: "direct" | "firecrawl";
  site: string;
  text: string;
  sha256: string;
  fetchedAt: string;
}

export type ExtractEntry = LibraryExtract | WebExtract;

/** A web extract before it has an id: the key is unique within its page. */
export type WebPart = Omit<WebExtract, "id" | "origin"> & { key: string };

export interface HitEntry {
  id: string;
  kind: "document" | "passage";
  rawId: string;
  section: string | null;
  /** A passage's section link; null for an Act. */
  url: string | null;
  /** The tool that first gave it. */
  from: string;
}

/** One source in the reply: what was read, and whether the answer cites it. The text stays in the run record. */
export type SourceEntry = Omit<LibraryExtract, "text"> | Omit<WebExtract, "text">;

export interface Citations {
  /** Everything read, each marked cited or not. */
  read: (SourceEntry & { cited: boolean })[];
  /** Ids the answer cites that the book never gave. */
  unknown: string[];
}

/** `[extract:L4]`, and the forms models drift into: `[extract: L4]`, `[extract:L4, L5]`. */
const CITATION = /\[extract:\s*([^\]]+)\]/gi;

export class IdBook {
  readonly #extracts: ExtractEntry[] = [];
  readonly #byKey = new Map<string, string>();
  readonly #hits: HitEntry[] = [];
  readonly #hitByRaw = new Map<string, HitEntry>();
  readonly #hitById = new Map<string, HitEntry>();
  readonly #links = new Set<string>();

  /** The short id for an Act (D…) or passage (P…), the same one each time it comes back. */
  hit(entry: Omit<HitEntry, "id">): string {
    const key = `${entry.kind} ${entry.rawId}`;
    const known = this.#hitByRaw.get(key);
    if (known) return known.id;
    const id = `${entry.kind === "document" ? "D" : "P"}${this.#hits.filter((h) => h.kind === entry.kind).length + 1}`;
    const made = { id, ...entry };
    this.#hits.push(made);
    this.#hitByRaw.set(key, made);
    this.#hitById.set(id, made);
    return id;
  }

  /** The hit behind a short id the model gave, or undefined for one this answer never got. */
  resolve(id: string): HitEntry | undefined {
    return this.#hitById.get(id.trim().toUpperCase());
  }

  get hits(): readonly HitEntry[] {
    return this.#hits;
  }

  get extracts(): readonly ExtractEntry[] {
    return this.#extracts;
  }

  /** How many ids and links the answer has had: a step that adds none brought back nothing new. */
  get size(): number {
    return this.#hits.length + this.#extracts.length + this.#links.size;
  }

  /** Library passages read, each under one id for the whole answer. */
  addRead(extracts: Omit<LibraryExtract, "id" | "origin">[]): string[] {
    return extracts.map((extract) => this.#add(`L ${extract.passageId}`, "L", { origin: "library", ...extract }));
  }

  /** The extracts of one page of a web read. */
  addWebRead(parts: readonly WebPart[]): string[] {
    return parts.map(({ key, ...part }) => this.#add(`W ${key}`, "W", { origin: "web", ...part }));
  }

  #add(key: string, prefix: "L" | "W", entry: Omit<LibraryExtract, "id"> | Omit<WebExtract, "id">): string {
    const known = this.#byKey.get(key);
    if (known) return known;
    const id = `${prefix}${this.#extracts.filter((e) => e.id.startsWith(prefix)).length + 1}`;
    this.#byKey.set(key, id);
    this.#extracts.push({ id, ...entry } as ExtractEntry);
    return id;
  }

  /** Note links the answer has seen (web_read reads only these), each without its `#` part. */
  seeLinks(urls: Iterable<string>): void {
    for (const raw of urls) {
      const url = normalLink(raw);
      if (url) this.#links.add(url);
    }
  }

  hasLink(raw: string): boolean {
    const url = normalLink(raw);
    return url !== null && this.#links.has(url);
  }

  /** What the answer cites, everything read, and any cited id the book never gave. */
  citations(answer: string): Citations {
    const cited = new Set<string>();
    const unknown = new Set<string>();
    const held = new Set(this.#extracts.map((e) => e.id));
    for (const match of answer.matchAll(CITATION)) {
      for (const part of (match[1] ?? "").split(/[,;\s]+/).filter((p) => /^[LW]\d+$/i.test(p))) {
        const id = part.toUpperCase();
        (held.has(id) ? cited : unknown).add(id);
      }
    }
    return {
      read: this.#extracts.map(({ text: _text, ...entry }) => ({ ...entry, cited: cited.has(entry.id) })),
      unknown: [...unknown],
    };
  }
}

/** A web link as the answer holds it: http or https, without its `#` part; null for anything else. */
export function normalLink(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** The web links written in a text, without trailing punctuation. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s"'<>\])]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}
