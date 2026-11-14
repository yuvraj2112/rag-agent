import assert from "node:assert/strict";
import { test } from "node:test";

import { bootstrap, compare, grouped, median, stampDiff } from "../src/stats.ts";

test("the bootstrap is seeded: the same data gives the same range", () => {
  const groups = [[0.2], [0.5, 0.6], [0.9], [0.4]];
  const a = bootstrap(groups);
  assert.deepEqual(a, bootstrap(groups));
  assert.ok(a && a.low <= a.mean && a.mean <= a.high);
  assert.equal(a?.mean, (0.2 + 0.5 + 0.6 + 0.9 + 0.4) / 5);
  assert.equal(bootstrap([]), null);
});

test("questions from one source are drawn together", () => {
  assert.deepEqual(grouped({ a: 1, b: 2, c: 3 }, { a: "g1", b: "g1", c: "g2" }), [[1, 2], [3]]);
});

test("a comparison counts questions won, lost and tied, on questions both runs scored", () => {
  const c = compare({ a: 0.5, b: 0.5, c: 0.5, d: 0.2 }, { a: 0.7, b: 0.3, c: 0.5 }, {});
  assert.equal(c.questions, 3);
  assert.deepEqual([c.won, c.lost, c.tied], [1, 1, 1]);
  assert.ok(c.difference && c.difference.low <= 0 && c.difference.high >= 0);
});

test("stamps that differ are named by their path", () => {
  const a = { model: { name: "m1", effort: "medium" }, prompt: { sha256: "p" }, tools: ["x"] };
  const b = { model: { name: "m2", effort: "medium" }, prompt: { sha256: "p" }, tools: ["x", "y"] };
  assert.deepEqual(stampDiff(a, b), ["model.name", "tools"]);
  assert.deepEqual(stampDiff(a, a), []);
});

test("median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});
