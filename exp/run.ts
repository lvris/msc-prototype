/**
 * run.ts — the Q1 collector.
 *
 *   pnpm exp:run --backend random                      # the floor, no model needed
 *   pnpm exp:run --backend openai --model qwen2.5:7b   # local model via Ollama
 *   pnpm exp:run --backend openai --model llama3.1:8b --repeats 3
 *
 * Every task in `exp/tasks.json` is run under every condition (H, J, J+) with the
 * same chooser, and every step is appended to a JSONL log. Episodes are strictly
 * sequential: the site holds one global session, and the harness pins it per
 * episode via `/__session`.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openaiChooser, modelConfigFromEnv, randomChooser } from "../a/choose.ts";
import type { Chooser } from "../a/choose.ts";
import { BASE, startSite } from "../b1/explore.ts";
import { type EpisodeRecord, runEpisode, type Task } from "./episode.ts";
import { CONDITIONS, type Condition } from "./surface.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const backend = arg("--backend", "random");
const model = arg("--model", backend === "random" ? "random" : (process.env.A_MODEL ?? "qwen2.5:7b"));
const repeats = Number(arg("--repeats", "3"));
/** first repetition index, so a later batch can extend an earlier one without redoing it. */
const repFrom = Number(arg("--rep-from", "1"));
const conditions = arg("--conditions", CONDITIONS.join(",")).split(",") as Condition[];
const temperature = Number(arg("--temp", "0"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = arg("--out", join(HERE, "logs", `${model.replace(/[^\w.-]/g, "_")}-${stamp}.jsonl`));

function chooserFor(rep: number, taskId: string, condition: Condition): Chooser {
  if (backend === "random") {
    // a distinct but reproducible stream per cell
    let seed = rep * 7919;
    for (const ch of `${taskId}/${condition}`) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    return randomChooser(seed || 1);
  }
  return openaiChooser({ ...modelConfigFromEnv(), model, temperature });
}

const only = arg("--tasks", ""); // comma-separated ids or class prefixes, e.g. "T1-01,T3"
const all: Task[] = JSON.parse(await readFile(join(HERE, "tasks.json"), "utf8")).tasks;
const tasks = only ? all.filter((t) => only.split(",").some((p) => t.id.startsWith(p))) : all;

await startSite();
mkdirSync(dirname(out), { recursive: true });

console.log(
  `backend=${backend} model=${model} temp=${temperature} reps=${repFrom}..${repFrom + repeats - 1} ` +
    `conditions=${conditions.join(",")}`,
);
if (backend !== "random" && temperature === 0 && repeats > 1) {
  console.log("⚠ temperature 0 is greedy: repeats will reproduce the same trajectory, not sample it.");
}
console.log(`tasks=${tasks.length}  episodes=${tasks.length * conditions.length * repeats}`);
console.log(`log → ${out}\n`);

let done = 0;
const total = tasks.length * conditions.length * repeats;

for (let rep = repFrom; rep < repFrom + repeats; rep++) {
  for (const condition of conditions) {
    for (const task of tasks) {
      const runId = `${model}@t${temperature}/${condition}/${task.id}/r${rep}`;
      let rec: EpisodeRecord;
      try {
        rec = await runEpisode({
          base: BASE, task, condition, chooser: chooserFor(rep, task.id, condition), model, temperature, runId,
        });
      } catch (e) {
        rec = {
          runId, condition, model, temperature, taskId: task.id, taskClass: task.class, intent: task.intent,
          steps: [], stopReason: "chooser_error", succeeded: false, abandoned: false,
          error: (e as Error).message,
        };
      }
      appendFileSync(out, `${JSON.stringify(rec)}\n`);

      const invalid = rec.steps.filter((s) => !s.inValidSet).length;
      done++;
      console.log(
        `[${String(done).padStart(3)}/${total}] ${condition.padEnd(2)} ${task.id} ` +
          `${rec.succeeded ? "✓" : "✗"} steps=${rec.steps.length} invalid=${invalid} (${rec.stopReason})` +
          (rec.error ? ` — ${rec.error.slice(0, 80)}` : ""),
      );
    }
  }
}

console.log(`\ndone → ${out}`);
process.exit(0);
