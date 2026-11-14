/**
 * Build the library, `data/library.db`, one of two ways:
 *
 *     npm run seed               copy the ready-made library (data/library.db.gz): seconds, free, and
 *                                it comes with a vector per passage for meaning search
 *     npm run seed -- --fresh    download each Act in data/law/ again (its latest version), build the
 *                                library and embed every passage: about a minute and $0.20 (OpenAI)
 *
 * The ready-made copy was built from the Acts in data/law/ as the repo ships them; if those files have
 * changed, it says so and stops. The library's fingerprint (the law files, and whether it has vectors)
 * is stamped on every run, so two runs on different libraries can't be mistaken for one.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";

import { embedMany } from "ai";

import { config } from "../src/config.ts";
import { sectionKey } from "../src/library.ts";
import { embeddingModel, embeddingOptions } from "../src/model.ts";
import { downloadAct, type ActLine, type SectionLine } from "./fetch-law.ts";

export const READY_MADE = "data/library.db.gz";

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, as_at TEXT NOT NULL, url TEXT NOT NULL);
CREATE TABLE passages (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), ord INTEGER NOT NULL,
  section TEXT NOT NULL, section_key TEXT NOT NULL, heading TEXT NOT NULL, part INTEGER NOT NULL,
  parts INTEGER NOT NULL, changes TEXT NOT NULL, url TEXT NOT NULL, text TEXT NOT NULL
);
CREATE INDEX passages_section ON passages (section_key);
CREATE INDEX passages_place ON passages (document_id, ord, part);
CREATE VIRTUAL TABLE passages_fts USING fts5 (heading, text, content = 'passages', tokenize = 'porter unicode61');
CREATE TABLE vectors (id TEXT PRIMARY KEY, vector BLOB NOT NULL);
`;

/** Texts per embedding request: the provider caps tokens per request. */
const BATCH = 100;

const lawFiles = (lawDir: string) => readdirSync(lawDir).filter((f) => f.endsWith(".jsonl.gz")).sort();

/** A fingerprint of the Acts in a folder: what the library's text is built from. */
export function lawFingerprint(lawDir: string): string {
  const hash = createHash("sha256");
  for (const file of lawFiles(lawDir)) hash.update(gunzipSync(readFileSync(join(lawDir, file))));
  return hash.digest("hex").slice(0, 16);
}

export function seed(path: string, lawDir: string): { db: DatabaseSync; acts: ActLine[]; sections: (SectionLine & { documentId: string })[] } {
  const files = lawFiles(lawDir);
  if (files.length === 0) throw new Error(`no Acts in ${lawDir}: run npm run fetch-law first`);
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const acts: ActLine[] = [];
  const sections: (SectionLine & { documentId: string })[] = [];
  for (const file of files) {
    const lines = gunzipSync(readFileSync(join(lawDir, file))).toString("utf8").trim().split("\n");
    const [act, ...rest] = lines.map((line) => JSON.parse(line) as ActLine | SectionLine);
    acts.push(act as ActLine);
    for (const line of rest) sections.push({ ...(line as SectionLine), documentId: (act as ActLine).id });
  }
  const addDoc = db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?)");
  for (const a of acts) addDoc.run(a.id, a.title, a.summary, a.asAt, a.url);
  const add = db.prepare("INSERT INTO passages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  for (const s of sections) {
    add.run(s.id, s.documentId, s.order, s.section, sectionKey(s.section), s.heading, s.part, s.parts, JSON.stringify(s.changes), s.url, s.text);
  }
  db.exec("COMMIT");
  db.exec("INSERT INTO passages_fts (passages_fts) VALUES ('rebuild')");
  db.prepare("INSERT INTO meta VALUES ('fingerprint', ?)").run(lawFingerprint(lawDir));
  return { db, acts, sections };
}

/** Put the ready-made library in place, if it was built from the Acts now in `lawDir`. */
export function reuse(path: string, lawDir: string, copy: string = READY_MADE): void {
  if (!existsSync(copy)) throw new Error(`no ready-made library at ${copy}: run npm run seed -- --fresh`);
  writeFileSync(path, gunzipSync(readFileSync(copy)));
  const db = new DatabaseSync(path, { readOnly: true });
  const built = (db.prepare("SELECT value FROM meta WHERE key = 'fingerprint'").get() as { value: string } | undefined)?.value;
  db.close();
  if (built?.replace(/\+v$/, "") !== lawFingerprint(lawDir)) {
    rmSync(path);
    throw new Error(
      `${copy} was built from other Acts than the ones in ${lawDir}: run npm run seed -- --fresh, or put the repo's Acts back with git checkout ${lawDir}`,
    );
  }
}

async function addVectors(db: DatabaseSync, acts: ActLine[], sections: SectionLine[]): Promise<void> {
  const titles = new Map(acts.map((a) => [a.id, a.title]));
  const items = [
    ...acts.map((a) => ({ id: a.id, text: `${a.title}: ${a.summary}` })),
    ...sections.map((s) => ({
      id: s.id,
      text: `${titles.get((s as SectionLine & { documentId: string }).documentId)}, section ${s.section}${s.heading ? ` (${s.heading})` : ""}: ${s.text}`,
    })),
  ];
  const add = db.prepare("INSERT INTO vectors VALUES (?, ?)");
  let tokens = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const { embeddings, usage } = await embedMany({
      model: embeddingModel(),
      values: batch.map((item) => item.text),
      providerOptions: embeddingOptions(),
    });
    tokens += usage.tokens;
    batch.forEach((item, j) => add.run(item.id, new Uint8Array(new Float32Array(embeddings[j]!).buffer)));
    process.stdout.write(`\r  vectors: ${Math.min(i + BATCH, items.length)} of ${items.length}`);
  }
  const dollars = (tokens / 1_000_000) * config.embedding.pricePerMillion;
  process.stdout.write(`\n  ${tokens.toLocaleString()} tokens, about $${dollars.toFixed(2)}\n`);
  db.prepare("INSERT INTO meta VALUES ('embedding', ?)").run(`${config.embedding.model}/${config.embedding.dimensions}`);
  // The vectors are part of what a search returns, so they change the fingerprint too.
  db.prepare("UPDATE meta SET value = value || '+v' WHERE key = 'fingerprint'").run();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--fresh")) {
    console.error("usage: npm run seed              copy the ready-made library (free, with vectors)");
    console.error("       npm run seed -- --fresh   download the Acts again and embed them (about $0.20)");
    process.exit(1);
  }
  const values = { fresh: args.includes("--fresh") };
  const path = config.library.path;
  const lawDir = "data/law";
  if (values.fresh) {
    if (!config.openaiApiKey) throw new Error("--fresh embeds every passage with OpenAI: set OPENAI_API_KEY in .env first");
    for (const file of lawFiles(lawDir)) {
      const [, year, number] = /^(\d{4})-(\d+)\.jsonl\.gz$/.exec(file) ?? [];
      if (year && number) console.log(`  ${await downloadAct(year, number, lawDir)}`);
    }
    const { db, acts, sections } = seed(path, lawDir);
    await addVectors(db, acts, sections);
    db.close();
  } else reuse(path, lawDir);

  const db = new DatabaseSync(path, { readOnly: true });
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const meta = Object.fromEntries((db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((m) => [m.key, m.value]));
  console.log(`${path}${values.fresh ? "" : ` (copied from ${READY_MADE})`}: ${count("SELECT count(*) n FROM documents")} Acts, ${count("SELECT count(*) n FROM passages")} passages, fingerprint ${meta.fingerprint}`);
  for (const a of db.prepare("SELECT title, as_at FROM documents").all() as { title: string; as_at: string }[]) console.log(`  ${a.title}, as at ${a.as_at}`);
  console.log(meta.embedding ? `  vectors: ${meta.embedding} (used when EMBEDDINGS=auto)` : "  keyword search only");
  db.close();
}
