/** What the tests share: a made-up Act seeded into a fresh library, and a scripted stand-in model. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { MockLanguageModelV4 } from "ai/test";

import { parseAct } from "../scripts/fetch-law.ts";
import { seed } from "../scripts/seed.ts";
import { openLibrary } from "../src/library.ts";

export const WIDGET_ACT = `<?xml version="1.0"?>
<act id="DLM1" date.as.at="2026-06-30"><cover><title>Widget Tax Act 2020</title><long-title>An Act to tax widgets</long-title></cover>
<body>
<prov id="DLM10"><label>1</label><heading>Short title</heading><prov.body><subprov><label>1</label><para><text>This Act is the Widget Tax Act 2020.</text></para></subprov></prov.body></prov>
<prov id="DLM20"><label>2</label><heading>Widget income</heading><prov.body><subprov id="DLM22"><label>1</label><para><text>Widget income is taxable at 10%.</text></para></subprov></prov.body>
<notes><history><history-note id="DLM21"><amending-operation>amended</amending-operation>, on <amendment-date>1 April 2025</amendment-date>, by <amending-leg>Widget Amendment Act 2025</amending-leg></history-note></history></notes></prov>
<prov id="DLM30"><label>3</label><heading>Exempt widgets</heading><prov.body><subprov><label>1</label><para><text>Small widgets are exempt.</text><label-para deletion-status="repealed"><label>a</label><para><text/></para></label-para></para></subprov></prov.body></prov>
</body>
<schedule id="DLM40"><label>1</label><heading>Rates</heading><prov id="DLM41"><label>1</label><heading>Rate</heading><prov.body><subprov><label>1</label><para><text>The rate is 10%.</text></para></subprov></prov.body></prov></schedule>
</act>`;

/** A library holding only the Widget Tax Act. */
export function testLibrary() {
  const dir = mkdtempSync(join(tmpdir(), "rag-agent-lib-"));
  const lines = parseAct(WIDGET_ACT, "https://example.test/widget", "act_widget");
  writeFileSync(join(dir, "widget.jsonl.gz"), gzipSync(lines.map((l) => JSON.stringify(l)).join("\n")));
  const path = join(dir, "library.db");
  seed(path, dir).db.close();
  return openLibrary(path);
}

const usage = { inputTokens: { total: 1_000, noCache: 800, cacheRead: 200, cacheWrite: 0 }, outputTokens: { total: 300, text: 200, reasoning: 100 } };

type Reply = { content: unknown[]; finish?: "stop" | "tool-calls" | "length" };

export const answer = (text: string): Reply => ({ content: [{ type: "text", text }] });

export const askFor = (toolName: string, input: object, id = `call-${toolName}-${Math.random()}`): Reply => ({
  content: [{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) }],
  finish: "tool-calls",
});

/** A model that gives these replies in order (the last again if it runs out), keeping every request. */
export function scriptedModel(...replies: Reply[]) {
  const calls: { prompt: unknown; toolChoice?: unknown; tools?: unknown }[] = [];
  const model = new MockLanguageModelV4({
    modelId: "stand-in",
    doGenerate: async (options) => {
      calls.push(options as never);
      // Told to answer without tools, a real model does; so does this one.
      const forced = (options as { toolChoice?: { type: string } }).toolChoice?.type === "none";
      const reply = forced ? answer("Answer from what was read.") : (replies[Math.min(calls.length, replies.length) - 1] ?? answer(""));
      const finish = reply.finish ?? "stop";
      return {
        content: reply.content,
        finishReason: { unified: finish, raw: finish },
        usage,
        response: { id: `resp-${calls.length}`, modelId: "stand-in", timestamp: new Date(0) },
        warnings: [],
      } as never;
    },
  });
  return { model, calls };
}
