/**
 * The API:
 *
 *     GET  /health   ok, and the agent's stamps (so a caller can check what it is about to test)
 *     POST /ask      { "question": "...", "country": "nz", "date": "2026-11-11" }  →  the Reply in run.ts
 *
 * `country` and `date` are optional; `date` answers as if today were that day. With `AGENT_KEY`
 * set, every call must send `Authorization: Bearer <key>`.
 */

import { timingSafeEqual } from "node:crypto";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";

import { config } from "./config.ts";
import { COUNTRIES, localToday, type Country } from "./prompt.ts";
import { runQuestion, setup, type Agent, type Reply, type Request } from "./run.ts";

const askBody = z
  .object({
    question: z.string().min(1),
    country: z.enum(Object.keys(COUNTRIES) as [Country]).optional(),
    date: z.iso.date().optional(),
  })
  .strict();

function keyMatches(given: string, key: string): boolean {
  const a = Buffer.from(key);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(
  agent: Agent,
  run: (request: Request, agent: Agent) => Promise<Reply> = runQuestion,
  key: string = config.server.key,
): Hono {
  const app = new Hono();

  app.use(async (c, next) => {
    const offered = (c.req.header("authorization") ?? "").replace(/^bearer\s+/i, "");
    if (key && !keyMatches(offered, key)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok", stamps: agent.stamps }));

  app.post("/ask", async (c) => {
    const body = askBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      const issue = body.error.issues[0];
      return c.json({ error: "invalid_request", detail: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "bad body" }, 422);
    }
    const reply = await run(
      { question: body.data.question, country: body.data.country ?? null, today: body.data.date ?? localToday() },
      agent,
    );
    return c.json(reply, reply.status === "failed" ? 502 : 200);
  });

  return app;
}

if (import.meta.main) {
  const agent = setup();
  const { host, port } = config.server;
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !config.server.key) {
    console.error(`refusing to listen on ${host} without AGENT_KEY`);
    process.exit(1);
  }
  serve({ fetch: createApp(agent).fetch, hostname: host, port }, () => {
    const s = agent.stamps;
    console.log(`rag-agent listening on http://${host}:${port}`);
    console.log(`  model ${s.model.name} (${s.model.effort}) · tools ${agent.names.join(", ") || "none"} · prompt ${s.prompt.sha256}`);
    if (s.library) console.log(`  library ${s.library.fingerprint} · ${s.library.vectors ? "vectors" : "keyword search"}${s.plants ? " · PLANTED ATTACK ON" : ""}`);
    console.log(`  run records → ${config.runsDir}/`);
  });
}
