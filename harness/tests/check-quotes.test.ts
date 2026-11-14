import assert from "node:assert/strict";
import { test } from "node:test";

import { locate, normal } from "../scripts/check-quotes.ts";

const law = [{ act: "Widget Act 2020", section: "5", text: normal("A widget is taxed at the rate of\n15% on the supply’s value, under subsection (1) (a).") }];

test("a quote is found whatever its quote marks, line breaks and label spacing", () => {
  assert.equal(locate("taxed at the rate of 15% on the supply's value", law)?.section, "5");
  assert.equal(locate("under subsection (1)(a)", law)?.section, "5");
});

test("words the Act doesn't contain are not found", () => {
  assert.equal(locate("taxed at the rate of 12.5%", law), undefined);
});
