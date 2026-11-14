/**
 * The library: a SQLite file of Acts and their sections (`npm run seed` builds it), opened read-only.
 *
 * ← To use another database, give `openLibrary` another body that returns these same four
 * functions. The tools call nothing else. `db` is there for tools of your own.
 *
 * Search: a section code or exact words go to SQL. A query goes to the vectors when the library
 * has them, and to SQLite's full-text index (BM25) when it doesn't. A few thousand vectors fit in
 * memory, so a plain loop ranks them: no vector database.
 */

import { DatabaseSync } from "node:sqlite";

import { cosineSimilarity, embed } from "ai";

import { config } from "./config.ts";
import { embeddingModel, embeddingOptions } from "./model.ts";

export interface LibraryDocument {
  id: string;
  title: string;
  summary: string;
  asAt: string;
  url: string;
}

export interface Passage {
  id: string;
  documentId: string;
  /** The Act's title. */
  title: string;
  order: number;
  section: string;
  heading: string;
  part: number;
  parts: number;
  changes: { date: string; kind: string; by: string }[];
  /** The section's link on legislation.govt.nz: every part of a section has the same one. */
  url: string;
  text: string;
}

export interface Page<T> {
  hits: T[];
  more: boolean;
}

export interface Library {
  /** Acts by meaning (`query`) and/or by `words` in their title or summary, in that order. */
  findDocuments(input: { query?: string; words?: string }, page: number): Promise<Page<LibraryDocument>>;
  /** Passages by meaning, by words in order, by section code, inside some documents, or any mix. */
  findPassages(
    input: { query?: string; words?: string; section?: string; in?: string[] },
    page: number,
  ): Promise<Page<Passage>>;
  /** Every part of the section a passage belongs to, and the sections either side. */
  readSection(passageId: string): Promise<{ parts: Passage[]; next: Passage | null; previous: Passage | null } | null>;
  /** An Act and its sections in order (their first parts). */
  readOutline(documentId: string): Promise<{ document: LibraryDocument; sections: Passage[] } | null>;
  /** What was seeded, stamped on every run. */
  info: { fingerprint: string; vectors: boolean; acts: { title: string; asAt: string }[] };
  db: DatabaseSync;
}

export const HITS_PER_PAGE = 10;

/** "s CB 6", "section 14" and "cb 6" are one key; the two hyphen forms match. */
export function sectionKey(code: string): string {
  return code
    .trim()
    .replace(/^(?:section|s)\.?\s+/i, "")
    .replace(/[‐-—]/g, "-")
    .replace(/[,\s]+/g, " ")
    .toLowerCase();
}

/** Words for full-text search: any of the query's words, ranked by BM25. */
const anyOf = (text: string) =>
  (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => `"${word}"`).join(" OR ");

/** The words in this order, as one phrase. */
const phrase = (text: string) => `"${(text.match(/[\p{L}\p{N}]+/gu) ?? []).join(" ")}"`;

const flat = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

interface Row {
  id: string;
  document_id: string;
  title: string;
  ord: number;
  section: string;
  heading: string;
  part: number;
  parts: number;
  changes: string;
  url: string;
  text: string;
}

const toPassage = (r: Row): Passage => ({
  id: r.id,
  documentId: r.document_id,
  title: r.title,
  order: r.ord,
  section: r.section,
  heading: r.heading,
  part: r.part,
  parts: r.parts,
  changes: JSON.parse(r.changes) as Passage["changes"],
  url: r.url,
  text: r.text,
});

const PASSAGE = `SELECT p.*, d.title FROM passages p JOIN documents d ON d.id = p.document_id`;

export function openLibrary(path: string = config.library.path): Library {
  const db = new DatabaseSync(path, { readOnly: true });
  const meta = Object.fromEntries(
    (db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((m) => [m.key, m.value]),
  );
  const documents = db.prepare("SELECT id, title, summary, as_at AS asAt, url FROM documents").all() as unknown as LibraryDocument[];
  const seededWith = meta.embedding ?? "";
  const wanted = `${config.embedding.model}/${config.embedding.dimensions}`;
  const vectors = config.library.embeddings !== "off" && seededWith !== "";
  if (vectors && seededWith !== wanted) {
    throw new Error(`the library's vectors were made with ${seededWith}, not ${wanted}: run npm run seed -- --fresh, or set EMBEDDINGS=off`);
  }

  let held: Map<string, Float32Array> | null = null;
  const vectorOf = (id: string) => {
    held ??= new Map(
      (db.prepare("SELECT id, vector FROM vectors").all() as { id: string; vector: Uint8Array }[]).map((v) => [
        v.id,
        new Float32Array(v.vector.buffer, v.vector.byteOffset, v.vector.byteLength / 4),
      ]),
    );
    return held.get(id);
  };
  const embedQuery = async (text: string) =>
    (await embed({ model: embeddingModel(), value: text, providerOptions: embeddingOptions() })).embedding;
  /** Rank by meaning, best first. */
  const byMeaning = async <T extends { id: string }>(items: T[], query: string) => {
    const q = await embedQuery(query);
    return items
      .map((item) => ({ item, score: cosineSimilarity(q, [...(vectorOf(item.id) ?? [])]) }))
      .sort((a, b) => b.score - a.score)
      .map((s) => s.item);
  };
  const pageOf = <T>(items: T[], page: number): Page<T> => ({
    hits: items.slice((page - 1) * HITS_PER_PAGE, page * HITS_PER_PAGE),
    more: items.length > page * HITS_PER_PAGE,
  });

  return {
    db,
    info: {
      fingerprint: meta.fingerprint ?? "unknown",
      vectors,
      acts: documents.map((d) => ({ title: d.title, asAt: d.asAt })),
    },

    async findDocuments({ query, words }, page) {
      let found = documents.filter((d) => !words || flat(`${d.title} ${d.summary}`).includes(flat(words)));
      if (query && vectors) found = await byMeaning(found, query);
      else if (query) {
        const wordsOf = (t: string) => new Set(flat(t).match(/[\p{L}\p{N}]+/gu) ?? []);
        const asked = wordsOf(query);
        const score = (d: LibraryDocument) => [...wordsOf(`${d.title} ${d.summary}`)].filter((w) => asked.has(w)).length;
        found = found.filter((d) => score(d) > 0).sort((a, b) => score(b) - score(a));
      }
      return pageOf(found, page);
    },

    async findPassages({ query, words, section, in: within }, page) {
      const where: string[] = [];
      const args: (string | number)[] = [];
      const match = [words ? phrase(words) : "", query && !vectors ? anyOf(query) : ""].filter(Boolean);
      if (match.length > 0) {
        where.push("p.rowid IN (SELECT rowid FROM passages_fts WHERE passages_fts MATCH ?)");
        args.push(match.map((m) => `(${m})`).join(" AND "));
      }
      if (section) {
        where.push("p.section_key = ?");
        args.push(sectionKey(section));
      }
      if (within && within.length > 0) {
        where.push(`p.document_id IN (${within.map(() => "?").join(", ")})`);
        args.push(...within);
      }
      const ranked = query && !vectors;
      const sql =
        `${PASSAGE} ${ranked ? "JOIN passages_fts f ON f.rowid = p.rowid AND passages_fts MATCH ?" : ""}` +
        ` ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}` +
        ` ORDER BY ${ranked ? "bm25(passages_fts)" : "p.document_id, p.ord, p.part"}`;
      const rows = db.prepare(sql).all(...(ranked ? [anyOf(query)] : []), ...args) as unknown as Row[];
      let found = rows.map(toPassage);
      if (query && vectors) found = await byMeaning(found, query);
      return pageOf(found, page);
    },

    async readSection(passageId) {
      const base = db.prepare(`${PASSAGE} WHERE p.id = ?`).get(passageId) as Row | undefined;
      if (!base) return null;
      const parts = (db.prepare(`${PASSAGE} WHERE p.document_id = ? AND p.ord = ? ORDER BY p.part`).all(base.document_id, base.ord) as unknown as Row[]).map(toPassage);
      const near = (ord: number) => {
        const row = db.prepare(`${PASSAGE} WHERE p.document_id = ? AND p.ord = ? AND p.part = 1`).get(base.document_id, ord) as Row | undefined;
        return row ? toPassage(row) : null;
      };
      return { parts, next: near(base.ord + 1), previous: near(base.ord - 1) };
    },

    async readOutline(documentId) {
      const document = documents.find((d) => d.id === documentId);
      if (!document) return null;
      const rows = db.prepare(`${PASSAGE} WHERE p.document_id = ? AND p.part = 1 ORDER BY p.ord`).all(documentId) as unknown as Row[];
      return { document, sections: rows.map(toPassage) };
    },
  };
}
