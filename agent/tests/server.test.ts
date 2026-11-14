import "./env.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { setup, type Reply } from "../src/run.ts";
import { blockedBy, isPublicAddress } from "../src/tools/web.ts";
import { createApp } from "../src/server.ts";
import { testLibrary } from "./helpers.ts";

const agent = setup(testLibrary());
const fakeRun = async (request: { question: string; today: string }) =>
  ({ answer: `echo: ${request.question} (${request.today})`, status: "answered" }) as unknown as Reply;

const post = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/ask", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

test("health gives the stamps", async () => {
  const res = await createApp(agent, fakeRun).request("/health");
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { stamps: { agent: string } }).stamps.agent, "rag-agent");
});

test("ask runs the question, with the date given", async () => {
  const res = await post(createApp(agent, fakeRun), { question: "Q?", country: "nz", date: "2026-04-01" });
  assert.equal(((await res.json()) as Reply).answer, "echo: Q? (2026-04-01)");
});

test("a bad body is refused with the reason", async () => {
  const res = await post(createApp(agent, fakeRun), { question: "Q?", extra: 1 });
  assert.equal(res.status, 422);
  assert.equal((await post(createApp(agent, fakeRun), { question: "" })).status, 422);
});

test("with a key set, a call without it is refused", async () => {
  const app = createApp(agent, fakeRun, "secret");
  assert.equal((await post(app, { question: "Q?" })).status, 401);
  assert.equal((await post(app, { question: "Q?" }, { authorization: "Bearer secret" })).status, 200);
});

test("the web tools read public addresses only, and never a blocked page", () => {
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("10.0.0.1"), false);
  assert.equal(isPublicAddress("::ffff:127.0.0.1"), false);
  const list = { domains: [], urls: ["https://www.taxtechnical.ird.govt.nz/questions-we-ve-been-asked/2019/qb-19-09"] };
  assert.match(blockedBy("https://www.taxtechnical.ird.govt.nz/questions-we-ve-been-asked/2019/qb-19-09?x=1", list) ?? "", /block list/);
  assert.equal(blockedBy("https://www.legislation.govt.nz/act/public/1985/141/en/latest", list), null);
});
