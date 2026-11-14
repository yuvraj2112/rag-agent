/**
 * Test settings, imported first by every test file so they apply before `config` is read. No test
 * calls a real model: the key is blank, so code that reaches for the real one fails loudly.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAI_API_KEY = "";
process.env.FIRECRAWL_API_KEY = "";
process.env.AGENT_KEY = "";
process.env.PLANTS = "";
process.env.TOOLS = "library";
process.env.RUNS_DIR = mkdtempSync(join(tmpdir(), "rag-agent-runs-"));
