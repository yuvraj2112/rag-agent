/**
 * Checks that each point's quote really is in the law. Every gold point carries the exact words that
 * prove it, so a script can confirm them without a tax expert.
 *
 *     npm run check-quotes -- --set sets/starter.jsonl
 *
 * Reads the Acts the agent's library is built from (`../agent/data/law`, or `--law <dir>`). A quote from
 * something the library doesn't hold, such as Inland Revenue guidance, shows as not in the Acts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

import { loadSet } from "../src/set.ts";

export interface Section {
  act: string;
  section: string;
  text: string;
}

/** The same words, whatever the quote marks, dashes, line breaks and the space in "(1) (a)". */
export const normal = (s: string) =>
  s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").replace(/\) \(/g, ")(").trim();

export const locate = (quote: string, sections: Section[]) => sections.find((s) => s.text.includes(normal(quote)));

/** Every section of every Act, its parts joined back together. */
export function readLaw(dir: string): Section[] {
  const sections = new Map<string, Section>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl.gz"))) {
    const [act, ...rows] = gunzipSync(readFileSync(join(dir, file)))
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { title: string; url: string; section: string; text: string });
    for (const row of rows) {
      const key = row.url;
      const s = sections.get(key) ?? { act: act!.title, section: row.section, text: "" };
      s.text += `\n${row.text}`;
      sections.set(key, s);
    }
  }
  return [...sections.values()].map((s) => ({ ...s, text: normal(s.text) }));
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      set: { type: "string", default: "sets/nz-dev.jsonl" },
      law: { type: "string", default: "../agent/data/law" },
    },
  });
  const law = readLaw(values.law);
  let quoted = 0;
  let found = 0;
  for (const q of loadSet(values.set).questions) {
    for (const p of q.points.filter((p) => p.quote)) {
      quoted += 1;
      const hit = locate(p.quote!, law);
      if (hit) found += 1;
      const where = hit ? `${hit.act} ${/^\d/.test(hit.section) ? `s ${hit.section}` : hit.section}` : `not in the Acts (cites ${p.cite ?? "nothing"})`;
      console.log(`  ${hit ? "✓" : "✗"} ${p.id}: ${where}`);
    }
  }
  console.log(`${found} of ${quoted} quotes found word for word in the Acts`);
}
