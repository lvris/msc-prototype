/**
 * loop.ts — the discovery loop.
 *
 * Cold-start from an entry URL and, at each step: read the current representation,
 * discover the valid affordances, let the chooser pick one, fill any required
 * field the chooser could not, replay it, and read the next representation. A
 * carries no map of B's states or urls — it learns each state only by fetching it.
 */

import type { Affordance } from "./affordance.ts";
import { type Choice, type Chooser, manualChooser } from "./choose.ts";
import { describe } from "./describe.ts";
import { discover } from "./discover.ts";
import { ask, closeIo } from "./io.ts";
import { prepareValues, replay } from "./replay.ts";

const MAX_STEPS = 15;

/** Ask the user for any required field still missing after seeding + chooser. */
async function fillRequired(a: Affordance, values: Record<string, string>): Promise<void> {
  for (const f of a.fields) {
    if (!f.required) continue;
    if (values[f.name] !== undefined && values[f.name] !== "") continue;
    const hint = f.options?.length ? ` (${f.options.join(" / ")})` : "";
    values[f.name] = (await ask(`  ${f.label ?? f.name}${hint}: `)).trim();
  }
}

function summarize(affs: Affordance[]): string {
  if (affs.length === 0) return "  (no actions)";
  return affs
    .map((a, i) => {
      const needed = a.fields.filter((f) => f.type !== "hidden").map((f) => f.name);
      const fs = needed.length ? `  — needs: ${needed.join(", ")}` : "";
      return `  [${i}] ${a.label}${fs}`;
    })
    .join("\n");
}

function indent(block: string): string {
  return block
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

async function fetchPage(u: string): Promise<{ html: string; url: string }> {
  const r = await fetch(u, { redirect: "follow" });
  return { html: await r.text(), url: r.url || u };
}

export interface RunOptions {
  base: string;
  goal: string;
  chooser: Chooser;
}

export async function run({ base, goal, chooser }: RunOptions): Promise<void> {
  console.log("A — fixed generic hypermedia agent");
  console.log(`backend: ${chooser.name}`);
  console.log(`goal:    ${goal}`);
  console.log(`entry:   ${base}\n`);

  let page = await fetchPage(base);
  const history: string[] = [];

  for (let step = 1; step <= MAX_STEPS; step++) {
    const affs = discover(page.html);
    const state = describe(page.html);
    console.log(`── step ${step} ──────────────────────────────`);
    if (state) console.log(indent(state));
    console.log("\n  actions:");
    console.log(summarize(affs));

    if (affs.length === 0) {
      console.log("\nno actions left — stopping.\n");
      break;
    }

    let choice: Choice;
    try {
      choice = await chooser.choose({ goal, step, state, affordances: affs, history });
    } catch (e) {
      console.log(`  chooser failed (${(e as Error).message}); falling back to manual`);
      choice = await manualChooser().choose({ goal, step, state, affordances: affs, history });
    }

    if (choice.index < 0 || choice.index >= affs.length) {
      console.log(`\nagent stops (index ${choice.index}) — goal reached or nothing applicable.\n`);
      break;
    }

    const chosen = affs[choice.index];
    const values = prepareValues(chosen, choice.values);
    await fillRequired(chosen, values);

    console.log(`  → replay ${chosen.method} ${chosen.url}  ${JSON.stringify(values)}`);
    const res = await replay(chosen, values, page.url);
    history.push(`${chosen.method} ${chosen.url} (${chosen.label})`);

    if (res.refused) {
      console.log("  ✗ refused by guard (409) — not valid in this state");
    }
    page = { html: res.html, url: res.url };

    if (step === MAX_STEPS) console.log("\nreached step cap — stopping.\n");
  }

  closeIo();
}
