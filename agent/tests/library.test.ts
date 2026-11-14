import "./env.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { partsOf } from "../scripts/fetch-law.ts";
import { sectionKey } from "../src/library.ts";
import { testLibrary } from "./helpers.ts";

const library = testLibrary();

test("the seed keeps each section's code, heading, text, dates and link", async () => {
  const { hits } = await library.findPassages({ section: "2" }, 1);
  assert.equal(hits.length, 1);
  const s = hits[0]!;
  assert.equal(s.title, "Widget Tax Act 2020");
  assert.equal(s.heading, "Widget income");
  assert.equal(s.text, "(1) Widget income is taxable at 10%.");
  assert.deepEqual(s.changes, [{ date: "2025-04-01", kind: "amended", by: "Widget Amendment Act 2025" }]);
  assert.equal(s.url, "https://example.test/widget/#DLM20");
  assert.deepEqual(library.info.acts, [{ title: "Widget Tax Act 2020", asAt: "2026-06-30" }]);
});

test("repealed paragraphs and schedule clauses read as the law prints them", async () => {
  const [exempt] = (await library.findPassages({ section: "s 3" }, 1)).hits;
  assert.match(exempt!.text, /\(a\) \[Repealed\]/);
  const [clause] = (await library.findPassages({ section: "Schedule 1 clause 1" }, 1)).hits;
  assert.equal(clause!.heading, "Rate");
});

test("searches by words in order, and ranks a query by its words without vectors", async () => {
  assert.deepEqual((await library.findPassages({ words: "small widgets" }, 1)).hits.map((p) => p.section), ["3"]);
  assert.deepEqual((await library.findPassages({ words: "widgets small" }, 1)).hits, []);
  const ranked = (await library.findPassages({ query: "taxable widget income" }, 1)).hits.map((p) => p.section);
  assert.equal(ranked[0], "2");
  assert.equal(library.info.vectors, false);
});

test("a read gives the whole section and its neighbours; an outline lists the sections", async () => {
  const read = await library.readSection("DLM20");
  assert.equal(read?.parts.length, 1);
  assert.equal(read?.previous?.section, "1");
  assert.equal(read?.next?.section, "3");
  const outline = await library.readOutline("act_widget");
  assert.deepEqual(outline?.sections.map((s) => s.section), ["1", "2", "3", "Schedule 1 clause 1"]);
});

test("section codes match however they are written", () => {
  assert.equal(sectionKey("s CB 6"), "cb 6");
  assert.equal(sectionKey("Section 14"), "14");
  assert.equal(sectionKey("8‑1"), "8-1");
});

test("long sections are cut between lines", () => {
  const parts = partsOf("a".repeat(40) + "\n" + "b".repeat(40), 50);
  assert.deepEqual(parts, ["a".repeat(40), "b".repeat(40)]);
});
