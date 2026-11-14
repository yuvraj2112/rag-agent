/**
 * The report page, run in the browser. report.ts strips the types and puts this file, after
 * stats.ts, into results/report.html, with every run's data beside it as JSON.
 *
 * Everything shown is built with textContent, never as HTML: answers are data, whatever they say.
 */

import { compare, stampDiff } from "./stats.ts";
import type { RunView, ScoredAnswer, ScoredQuestion } from "./score.ts";

const runs = JSON.parse(document.getElementById("data")!.textContent!) as RunView[];
const app = document.getElementById("app")!;

type Child = Node | string | null | undefined | false;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const fixed = (n: number | null | undefined, digits = 3) => (n === null || n === undefined ? "—" : n.toFixed(digits));
const mark = (pass: boolean | null) =>
  h("span", { class: pass === null ? "na" : pass ? "good" : "bad" }, pass === null ? "–" : pass ? "✓" : "✗");

function picker(label: string, selected: number, withNone: boolean, onChange: (i: number) => void): HTMLElement {
  const select = h("select") as HTMLSelectElement;
  if (withNone) select.append(h("option", { value: "-1" }, "nothing"));
  runs.forEach((r, i) => select.append(h("option", { value: String(i) }, `${r.meta.name} (${r.meta.created.slice(0, 16).replace("T", " ")})`)));
  select.value = String(selected);
  select.onchange = () => onChange(Number(select.value));
  return h("label", {}, `${label} `, select);
}

const scoresOf = (run: RunView) =>
  Object.fromEntries(run.questions.filter((q) => q.score !== null).map((q) => [q.question.id, q.score!]));

function summary(run: RunView): HTMLElement {
  const s = run.summary;
  const st = run.meta.stamps as Record<string, any>;
  const facts: [string, string][] = [
    ["Answers", `${s.answers} (${s.judged} judged) · ${run.meta.runs} per question`],
    ["Strict passes", `${s.strictPasses} of ${s.answers} · right every time on ${s.strictEveryTime} of ${s.questions}`],
    ["Confidently wrong", String(s.confidentWrong)],
    ["Agent cost", `$${fixed(s.agentDollars, 2)} · median $${fixed(s.medianDollars)} and ${fixed(s.medianSeconds, 1)} s an answer`],
    ["Judge", `${run.meta.judge} · $${fixed(s.judgeDollars, 2)}`],
    ["Model", `${st.model?.name} (${st.model?.effort})`],
    ["Tools", (st.tools ?? []).map((t: { name: string }) => t.name).join(", ") || "none (the floor)"],
    ["Library", st.library ? `${st.library.fingerprint} · ${st.library.vectors ? "vectors" : "keyword search"}` : "—"],
    ["Prompt", st.prompt?.sha256 ?? "—"],
    ["Planted attack", st.plants ? `on ("${st.plants.marker}")` : "off"],
    ["Code", `${String(st.code?.commit ?? "").slice(0, 7)}${st.code?.dirty ? " + uncommitted changes" : ""}`],
  ];
  const checks = h("table", {}, h("tr", {}, h("th", {}, "Check"), h("th", {}, "Pass"), h("th", {}, "Fail")));
  for (const [name, c] of Object.entries(s.checks)) {
    if (c.pass + c.fail > 0) checks.append(h("tr", {}, h("td", {}, name), h("td", { class: "good" }, String(c.pass)), h("td", { class: c.fail ? "bad" : "muted" }, String(c.fail))));
  }
  return h(
    "section",
    { class: "grid" },
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Score"),
      h("div", { class: "big" }, fixed(s.headline?.mean)),
      h("div", { class: "muted" }, s.headline ? `95% range ${fixed(s.headline.low)}–${fixed(s.headline.high)}` : "not judged yet"),
    ),
    h("div", { class: "card" }, h("h2", {}, "Run"), ...facts.map(([k, v]) => h("div", {}, h("span", { class: "muted" }, `${k}: `), v))),
    h("div", { class: "card scroll" }, h("h2", {}, "Code checks"), checks),
  );
}

function comparison(run: RunView, base: RunView): HTMLElement {
  const groupOf = Object.fromEntries(run.questions.map((q) => [q.question.id, q.question.group]));
  const c = compare(scoresOf(base), scoresOf(run), groupOf);
  const changed = stampDiff(base.meta.stamps, run.meta.stamps);
  const d = c.difference;
  const clear = d && (d.low > 0 || d.high < 0);
  return h(
    "section",
    { class: "card" },
    h("h2", {}, `Against ${base.meta.name}`),
    h("div", { class: "big" }, d ? `${d.mean >= 0 ? "+" : ""}${fixed(d.mean)}` : "—"),
    h("div", { class: "muted" }, d ? `95% range ${fixed(d.low)} to ${fixed(d.high)}: ${clear ? "bigger than the noise" : "within the noise"}` : ""),
    h("div", {}, `${c.questions} questions: ${c.won} better, ${c.lost} worse, ${c.tied} the same`),
    h(
      "div",
      { class: changed.length > 1 ? "warn" : "" },
      `What changed: ${changed.join(", ") || "nothing in the stamps"}`,
      changed.length > 1 ? " — more than one thing, so the difference can't be put down to one change." : "",
    ),
  );
}

function answerDetail(q: ScoredQuestion, a: ScoredAnswer): HTMLElement {
  const r = a.reply;
  const box = h(
    "div",
    { class: "card" },
    h(
      "h3",
      {},
      `Answer ${a.k} · score ${fixed(a.score)} · ${a.strict === null ? "not judged" : a.strict ? "strict pass" : "not a strict pass"}`,
      r ? ` · ${r.status} (${r.stopReason}) · $${fixed(r.run?.totals?.dollars)} · ${r.run?.totals?.seconds} s` : "",
    ),
    h("div", { class: "answer" }, r?.answer || a.error || "(no answer)"),
  );
  const checks = h("table", {});
  for (const c of a.checks) checks.append(h("tr", {}, h("td", {}, mark(c.pass)), h("td", {}, c.name), h("td", { class: "muted" }, c.detail)));
  box.append(h("h3", {}, "Code checks"), h("div", { class: "scroll" }, checks));

  if (a.judged) {
    const says = new Map([...q.question.points, ...q.question.penalties].map((p) => [p.id, p.says]));
    const points = h("table", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Point"), h("th", {}, "Judge's quote and reason")));
    for (const v of a.judged.verdicts) {
      const met = v.verdict === "yes";
      const good = v.kind === "penalty" ? !met : met;
      points.append(
        h(
          "tr",
          {},
          h("td", {}, h("span", { class: v.verdict === "cant_tell" ? "na" : good ? "good" : "bad" }, met ? "yes" : v.verdict === "no" ? "no" : "?")),
          h("td", {}, `${v.id} (${v.kind}) `, h("span", { class: "muted" }, says.get(v.id) ?? "")),
          h("td", {}, v.quotes.length ? `“${v.quotes.join("” … “")}” ` : "", h("span", { class: "muted" }, v.reason)),
        ),
      );
    }
    box.append(h("h3", {}, `Points (judge: ${a.judged.model}, $${fixed(a.judged.dollars)})`), h("div", { class: "scroll" }, points));
  }

  if (r?.run?.steps?.length) {
    const trace = h("div", {});
    for (const s of r.run.steps) {
      const line =
        s.kind === "model"
          ? `round ${s.round} · model ${s.name} · ${s.ms ?? "?"} ms · $${fixed(s.dollars, 4)}`
          : `round ${s.round} · ${s.name} ${JSON.stringify(s.input)} · ${s.ms ?? "?"} ms${s.error ? ` · ERROR ${s.error}` : ""}\n${(s.result ?? "").slice(0, 400)}`;
      trace.append(h("div", { class: "step" }, line));
    }
    box.append(h("details", {}, h("summary", {}, `Trace: ${r.run.steps.length} calls`), trace));
  }
  if (r?.read?.length) {
    const read = h("ul", {});
    for (const s of r.read) read.append(h("li", {}, `${s.id} ${s.title}${s.section ? `, ${s.section}` : ""} `, h("span", { class: s.cited ? "good" : "muted" }, s.cited ? "cited" : "read, not cited")));
    const want = q.question.mustFind.filter((m) => m.inLibrary !== false && m.url).map((m) => `${m.act}, ${m.section}`);
    box.append(h("details", {}, h("summary", {}, `Sources: ${r.read.length} read, ${r.sources.length} cited${want.length ? ` · the gold needs ${want.join("; ")}` : ""}`), read));
  }
  return box;
}

function questions(run: RunView, base: RunView | null): HTMLElement {
  const baseScores = base ? scoresOf(base) : {};
  const table = h(
    "table",
    {},
    h("tr", {}, h("th", {}, "Question"), h("th", {}, "Type"), h("th", {}, "Topic"), h("th", {}, "Answers"), h("th", {}, "Score"), base && h("th", {}, "Change"), h("th", {}, "Checks failed")),
  );
  for (const q of run.questions) {
    const failed = q.answers.flatMap((a) => a.checks.filter((c) => c.pass === false).map((c) => c.name));
    const was = baseScores[q.question.id];
    const change = q.score !== null && was !== undefined ? q.score - was : null;
    const row = h(
      "tr",
      { class: "q" },
      h("td", {}, q.question.id),
      h("td", {}, q.question.type),
      h("td", {}, q.question.topic),
      h("td", {}, q.answers.map((a) => fixed(a.score, 2)).join(" · ")),
      h("td", {}, fixed(q.score)),
      base && h("td", { class: change === null || Math.abs(change) < 1e-9 ? "muted" : change > 0 ? "good" : "bad" }, change === null ? "—" : `${change > 0 ? "+" : ""}${fixed(change)}`),
      h("td", { class: failed.length ? "bad" : "muted" }, failed.length ? [...new Set(failed)].join(", ") : "none"),
    );
    const detail = h("tr", { hidden: "" }, h("td", { colspan: "7" }, h("p", {}, q.question.question), ...q.answers.map((a) => answerDetail(q, a))));
    row.onclick = () => (detail.hidden = !detail.hidden);
    table.append(row, detail);
  }
  return h("section", { class: "card scroll" }, h("h2", {}, "Questions (click one for its answers)"), table);
}

function render(selected: number, against: number): void {
  const run = runs[selected]!;
  const base = against >= 0 && against !== selected ? runs[against]! : null;
  const parts = [
    h("h1", {}, "rag-agent eval report"),
    h("div", { class: "bar" }, picker("Run", selected, false, (i) => render(i, against)), picker("Compare with", against, true, (i) => render(selected, i))),
    summary(run),
    base && comparison(run, base),
    questions(run, base),
  ];
  app.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
}

if (runs.length === 0) app.replaceChildren(h("h1", {}, "rag-agent eval report"), h("p", {}, "No runs yet: npm run eval"));
else render(runs.length - 1, -1);
