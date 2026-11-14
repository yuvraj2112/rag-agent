import "./env.ts";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { BUDGET_NOTE } from "../src/agent.ts";
import { config } from "../src/config.ts";
import { runQuestion, setup } from "../src/run.ts";
import { IdBook } from "../src/tools/ids.ts";
import { dateWarnings } from "../src/tools/library.ts";
import { PLANT_MARKER, plantedLibrary } from "../src/tools/plants.ts";
import { answer, askFor, scriptedModel, testLibrary } from "./helpers.ts";

const library = testLibrary();
const request = { question: "Is widget income taxed?", country: "nz" as const, today: "2026-11-11" };

test("search, read, cite: the reply lists what was read and what the answer cites", async () => {
  const { model } = scriptedModel(
    askFor("passage_search", { section: "2" }),
    askFor("library_read", { id: "P1" }),
    answer("As at 11 November 2026, widget income is taxable at 10% [extract:L1]."),
  );
  const reply = await runQuestion(request, setup(library), model);
  assert.equal(reply.status, "answered");
  assert.deepEqual(reply.sources.map((s) => [s.id, s.url]), [["L1", "https://example.test/widget/#DLM20"]]);
  assert.equal(reply.read.length, 1);
  assert.equal(reply.found[0]?.url, "https://example.test/widget/#DLM20");
  assert.deepEqual(reply.unknownCitations, []);
  assert.deepEqual(
    reply.run.steps.map((s) => `${s.kind} ${s.name}`),
    ["model stand-in", "tool passage_search", "model stand-in", "tool library_read", "model stand-in"],
  );
  assert.equal(reply.run.totals.modelCalls, 3);
  assert.ok(reply.run.totals.dollars > 0);
  assert.equal(reply.run.stamps.library?.fingerprint, library.info.fingerprint);
  const record = JSON.parse(readFileSync(reply.run.record, "utf8"));
  assert.match(record.extracts[0].text, /taxable at 10%/);
});

test("a cited id the run never gave is reported", async () => {
  const { model } = scriptedModel(answer("Taxable [extract:L7]."));
  const reply = await runQuestion(request, setup(library), model);
  assert.deepEqual(reply.unknownCitations, ["L7"]);
  assert.deepEqual(reply.sources, []);
});

test("after the last round the model is called once more with its tools off", async () => {
  const { model, calls } = scriptedModel(askFor("passage_search", { query: "widget" }));
  const reply = await runQuestion(request, setup(library), model);
  assert.equal(calls.length, config.limits.rounds + 1);
  assert.equal(calls.at(-1)?.toolChoice && (calls.at(-1)?.toolChoice as { type: string }).type, "none");
  assert.match(JSON.stringify(calls.at(-1)?.prompt), new RegExp(BUDGET_NOTE.slice(0, 20)));
  assert.equal(reply.answer, "Answer from what was read.");
});

test("a model that fails gives a failed reply, and its record is still written", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  const broken = new MockLanguageModelV4({ doGenerate: async () => Promise.reject(new Error("provider down")) });
  const reply = await runQuestion(request, setup(library), broken);
  assert.equal(reply.status, "failed");
  assert.match(reply.error ?? "", /provider down/);
  assert.ok(existsSync(reply.run.record));
});

test("the planted page comes first in an open search and reads like any passage", async () => {
  const planted = plantedLibrary(library);
  const { hits } = await planted.findPassages({ query: "widget" }, 1);
  assert.match(hits[0]!.text, new RegExp(PLANT_MARKER));
  assert.notEqual((await planted.findPassages({ section: "2" }, 1)).hits[0]?.id, "plant-1");
  assert.equal((await planted.readSection("plant-1"))?.parts[0]?.id, "plant-1");
});

test("a read warns when the section changed after the answer date", () => {
  const changes = [{ date: "2025-04-01", kind: "amended", by: "" }];
  assert.match(dateWarnings(changes, "2024-01-01").join(" "), /changed on 2025-04-01/);
  assert.deepEqual(dateWarnings(changes, "2026-01-01"), []);
});

test("hit ids come back the same, and an unknown id resolves to nothing", () => {
  const book = new IdBook();
  const first = book.hit({ kind: "passage", rawId: "DLM20", section: "2", url: null, from: "test" });
  assert.equal(book.hit({ kind: "passage", rawId: "DLM20", section: "2", url: null, from: "test" }), first);
  assert.equal(book.resolve("p1")?.rawId, "DLM20");
  assert.equal(book.resolve("P9"), undefined);
});
