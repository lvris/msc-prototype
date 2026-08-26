/**
 * report.ts — turn the JSONL logs into the Q1 table.
 *
 *   pnpm exp:report                       # every log in exp/logs
 *   pnpm exp:report --log exp/logs/x.jsonl
 *   pnpm exp:report --latex               # tabular rows for the thesis
 *
 * The headline number is the invalid action rate: proposals the server did not
 * consider legal in the state they were made, over all proposals.
 *
 * ⚠️ H is 0 by construction, not by measurement. The agent chooses from the
 * rendered set and I1 asserts rendered == valid, so no other value is expressible.
 * Any presentation of this table must say so, or the row reads as a result when it
 * is an invariant.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { EpisodeRecord } from "./episode.ts";
import { CONDITIONS, type Condition } from "./surface.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const logDir = join(HERE, "logs");
const only = arg("--log", "");
const asLatex = process.argv.includes("--latex");

const files = only
  ? [only]
  : readdirSync(logDir).filter((f) => f.endsWith(".jsonl")).map((f) => join(logDir, f));

const episodes: EpisodeRecord[] = files.flatMap((f) =>
  readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as EpisodeRecord),
);

if (episodes.length === 0) {
  console.error(`no episodes found in ${only || logDir}`);
  process.exit(1);
}

interface Cell {
  episodes: number;
  proposals: number;
  invalid: number;
  refused: number;
  succeeded: number;
  abstained: number;
  steps: number;
}

const empty = (): Cell => ({ episodes: 0, proposals: 0, invalid: 0, refused: 0, succeeded: 0, abstained: 0, steps: 0 });

/** model → condition → task class ("all" included) → cell */
const table = new Map<string, Map<Condition, Map<string, Cell>>>();

function cell(model: string, c: Condition, klass: string): Cell {
  const byCond = table.get(model) ?? new Map();
  table.set(model, byCond);
  const byClass = byCond.get(c) ?? new Map();
  byCond.set(c, byClass);
  const found = byClass.get(klass) ?? empty();
  byClass.set(klass, found);
  return found;
}

/** Different decoding temperatures are different regimes, never one pooled cell. */
const armOf = (e: EpisodeRecord): string => `${e.model}@t${e.temperature ?? 0}`;

for (const e of episodes) {
  for (const klass of ["all", e.taskClass]) {
    const k = cell(armOf(e), e.condition, klass);
    k.episodes++;
    k.steps += e.steps.length;
    k.proposals += e.steps.length;
    k.invalid += e.steps.filter((s) => !s.inValidSet).length;
    k.refused += e.steps.filter((s) => s.refused).length;
    if (e.succeeded) k.succeeded++;
    if (e.stopReason === "agent_stop") k.abstained++;
  }
}

const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);

if (asLatex) {
  console.log("% invalid action rate / task success, by condition. H is 0 BY CONSTRUCTION.");
  for (const [model, byCond] of table) {
    for (const c of CONDITIONS) {
      const k = byCond.get(c)?.get("all");
      if (!k) continue;
      console.log(
        `${model} & ${c} & ${k.episodes} & ${k.proposals} & ${pct(k.invalid, k.proposals)} & ` +
          `${pct(k.refused, k.proposals)} & ${pct(k.succeeded, k.episodes)} \\\\`,
      );
    }
  }
} else {
  for (const [model, byCond] of table) {
    console.log(`\n══ ${model} ══`);
    console.log("cond  class  eps  props  invalid   refused   success   abstain   steps/ep");
    for (const c of CONDITIONS) {
      const byClass = byCond.get(c);
      if (!byClass) continue;
      for (const klass of ["all", "T1", "T2", "T3"]) {
        const k = byClass.get(klass);
        if (!k) continue;
        console.log(
          `${c.padEnd(5)} ${klass.padEnd(6)} ${String(k.episodes).padStart(3)} ` +
            `${String(k.proposals).padStart(6)} ${pct(k.invalid, k.proposals).padStart(8)} ` +
            `${pct(k.refused, k.proposals).padStart(9)} ${pct(k.succeeded, k.episodes).padStart(9)} ` +
            `${pct(k.abstained, k.episodes).padStart(9)} ${(k.steps / k.episodes).toFixed(1).padStart(10)}`,
        );
      }
      console.log("");
    }
  }
  console.log("note: H invalid = 0 is a structural guarantee, not a measurement.");
}
