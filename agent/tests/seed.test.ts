import "./env.ts";

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { parseAct } from "../scripts/fetch-law.ts";
import { reuse, seed } from "../scripts/seed.ts";
import { WIDGET_ACT } from "./helpers.ts";

/** A folder holding one Act's file, as fetch-law writes it. */
function lawDir(xml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rag-agent-law-"));
  const lines = parseAct(xml, "https://example.test/widget", "act_widget");
  writeFileSync(join(dir, "widget.jsonl.gz"), gzipSync(lines.map((l) => JSON.stringify(l)).join("\n")));
  return dir;
}

test("seed reuses the ready-made library only when it was built from the same Acts", () => {
  const law = lawDir(WIDGET_ACT);
  const built = join(law, "built.db");
  seed(built, law).db.close();
  const copy = join(law, "library.db.gz");
  writeFileSync(copy, gzipSync(readFileSync(built)));

  const target = join(law, "library.db");
  reuse(target, law, copy);
  assert.deepEqual(readFileSync(target), readFileSync(built));

  const changed = lawDir(WIDGET_ACT.replace("taxable at 10%", "taxable at 12%"));
  const elsewhere = join(changed, "library.db");
  assert.throws(() => reuse(elsewhere, changed, copy), /built from other Acts/);
  assert.equal(existsSync(elsewhere), false);
});
