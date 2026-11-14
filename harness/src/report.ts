/**
 * The report: one HTML file, `results/report.html`, holding every run saved under results/. Open it
 * by double-clicking: no server, no framework. A picker at the top chooses the run; a second picker
 * compares it with another, question by question.
 *
 * The page's code is `page.ts` and `stats.ts`, with their types stripped by Node and put in the
 * file, so the page computes a comparison with the same code as the tests check.
 *
 *     npm run report        rebuild it without running anything
 */

import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

import { config } from "./config.ts";
import { loadRuns } from "./score.ts";

const source = (file: string) => stripTypeScriptTypes(readFileSync(new URL(file, import.meta.url), "utf8"));

const STYLE = `
:root { --bg: #fbfaf8; --fg: #1d1c1a; --muted: #6b6760; --line: #e4e0d8; --card: #ffffff; --good: #1f7a3f; --bad: #b42318; --na: #8a857c; --accent: #2f5bd3; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #161513; --fg: #ecebe7; --muted: #a29d93; --line: #34312c; --card: #1e1d1a; --good: #58c27d; --bad: #f2877c; --na: #8a857c; --accent: #8fa8ff; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; padding: 24px max(16px, env(safe-area-inset-left)); }
main { max-width: 1100px; margin: 0 auto; display: grid; gap: 20px; }
h1 { font-size: 20px; margin: 0; } h2 { font-size: 15px; margin: 0 0 8px; } h3 { font-size: 14px; margin: 12px 0 4px; }
select { font: inherit; padding: 4px 8px; }
.bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; min-width: 0; }
.big { font-size: 32px; font-weight: 600; }
.muted { color: var(--muted); }
.good { color: var(--good); } .bad { color: var(--bad); } .na { color: var(--na); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr.q { cursor: pointer; } tr.q:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.answer { white-space: pre-wrap; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 10px; max-height: 420px; overflow: auto; }
.step { font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; border-left: 2px solid var(--line); padding-left: 8px; margin: 4px 0; }
.warn { border-left: 3px solid var(--bad); padding-left: 8px; }
`;

export function writeReport(resultsDir: string = config.resultsDir): string {
  const runs = loadRuns(resultsDir);
  // `<` is escaped so no answer text can close the script tag.
  const data = JSON.stringify(runs).replace(/</g, "\\u003c");
  const script = [source("./stats.ts"), source("./page.ts").replace(/^import .*$/gm, "")].join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>rag-agent eval report</title><style>${STYLE}</style></head>
<body><main id="app"><h1>rag-agent eval report</h1><p class="muted">Loading…</p></main>
<script type="application/json" id="data">${data}</script>
<script type="module">${script}</script>
</body></html>
`;
  const path = join(resultsDir, "report.html");
  writeFileSync(path, html);
  return path;
}

if (import.meta.main) console.log(writeReport());
