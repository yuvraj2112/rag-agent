/**
 * The numbers behind "is B better than A?". Plain functions with no imports, because the report page
 * runs them too (report.ts puts this file into the page).
 *
 * A score from 18 questions moves between runs on its own, so a difference means something only
 * when it is bigger than that noise. The 95% range comes from a bootstrap: draw the questions again,
 * with replacement, 10,000 times, and see where the mean lands. Questions built from the same
 * official item are drawn together, since they aren't independent.
 */

/** A small seeded random number generator, so a range comes out the same every time. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The mean of values that come in groups, and a 95% range from redrawing whole groups. */
export function bootstrap(groups: number[][], samples = 10_000, seed = 42): { mean: number; low: number; high: number } | null {
  const kept = groups.filter((g) => g.length > 0);
  const all = kept.flat();
  if (all.length === 0) return null;
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < samples; i++) {
    let total = 0;
    let count = 0;
    for (let j = 0; j < kept.length; j++) {
      const g = kept[Math.floor(random() * kept.length)]!;
      for (const x of g) total += x;
      count += g.length;
    }
    means.push(total / count);
  }
  means.sort((a, b) => a - b);
  return {
    mean: all.reduce((a, b) => a + b, 0) / all.length,
    low: means[Math.floor(0.025 * samples)]!,
    high: means[Math.min(samples - 1, Math.ceil(0.975 * samples) - 1)]!,
  };
}

/** Values keyed by question, gathered into their groups. */
export function grouped(values: Record<string, number>, groupOf: Record<string, string>): number[][] {
  const by: Record<string, number[]> = {};
  for (const [id, v] of Object.entries(values)) (by[groupOf[id] ?? id] ??= []).push(v);
  return Object.values(by);
}

/** B against A, question by question, on the questions both runs scored. */
export function compare(a: Record<string, number>, b: Record<string, number>, groupOf: Record<string, string>) {
  const diffs: Record<string, number> = {};
  for (const id of Object.keys(a)) if (id in b) diffs[id] = b[id]! - a[id]!;
  const d = Object.values(diffs);
  return {
    questions: d.length,
    difference: bootstrap(grouped(diffs, groupOf)),
    won: d.filter((x) => x > 1e-9).length,
    lost: d.filter((x) => x < -1e-9).length,
    tied: d.filter((x) => Math.abs(x) <= 1e-9).length,
    diffs,
  };
}

/** Every stamp that differs between two runs, by its dotted path ("model.name", "prompt.sha256"). */
export function stampDiff(a: unknown, b: unknown, path = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isObject = (x: unknown) => typeof x === "object" && x !== null && !Array.isArray(x);
  if (!isObject(a) || !isObject(b)) return [path || "(all)"];
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  return [...keys].flatMap((k) =>
    stampDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k),
  );
}
