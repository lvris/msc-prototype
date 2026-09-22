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
  /** proposals that named an action valid in the current state. */
  valid: number;
  /**
   * The two ways a proposal can be invalid, kept apart because they are different
   * mistakes. The split follows the benchmark literature's out-of-space vs
   * in-space-but-illegal distinction.
   *
   *   offCatalogue  the named thing does not exist at all — the model made it
   *                 up. Two conditions can express this and the rest cannot: P
   *                 by constructing a url nothing serves, and X / X+ by calling
   *                 a tool that was never offered. A condition that selects an
   *                 index out of a list has no way to say it.
   *   wrongState    a real operation of this application, issued where the state
   *                 does not allow it. This is the G1/G2/G5 mistake: the right
   *                 intent, the wrong one of two same-named operations.
   */
  offCatalogue: number;
  wrongState: number;
  /**
   * The same counts over DISTINCT attempts only — proposals whose (state,
   * request) pair had not already been refused earlier in the episode.
   *
   * Both denominators are reported because they answer different questions. The
   * pooled rate is per decision, which is what the benchmark literature's
   * invalid action rate means, but it lets one agent that repeats itself carry a
   * whole condition. The distinct rate asks how often the action source led
   * somewhere illegal at all, and is unmoved by how long the agent stayed there.
   * A large gap between them is itself a finding: it says the condition's rate
   * is made of few mistakes held for a long time, not many mistakes.
   */
  distinct: number;
  distinctInvalid: number;
  /**
   * Episodes that ended because the model produced neither a tool call nor the
   * stop token. Tool-calling conditions only; it is the no-tool-call rate, and
   * it belongs next to the invalid action rate rather than inside it — failing
   * to answer in the protocol is not the same as answering wrongly.
   */
  noToolCall: number;
  /**
   * Episodes cut because the identical refused request kept being re-sent from a
   * state that had not moved. Worth reading next to the invalid and wrong-value
   * columns: before the cut existed, a single stuck episode contributed twenty
   * proposals and could carry a whole condition's rate on its own.
   */
  stuck: number;
  /** tokens billed, summed over every step and every reprompt. */
  promptTokens: number;
  completionTokens: number;
  /**
   * Valid action, rejected anyway: the agent picked an operation the state allows
   * but submitted a value the server would not take — an empty card, a dish that
   * is not on the menu, a slot another party already has. Counted on `!executed`
   * rather than on a single status code: the server says 400 for a value it will
   * not accept and 409 for a slot already gone, and both are the same mistake.
   *
   * Under H this cannot happen. A hidden `slot=19:00` exists only on a control the
   * server rendered, and it rendered that control only because 19:00 is free, so
   * the value and its legality have one source. Everywhere else the value is
   * produced by the model, and what a model produces can be wrong.
   */
  wrongValue: number;
  /**
   * Steps that actually carry provenance. Logs written before it was recorded
   * still count as proposals, so without this the value columns would be read
   * against the wrong denominator.
   */
  provSteps: number;
  /** where the submitted values came from (see provenance.ts). */
  fixed: number;
  prefilled: number;
  intent: number;
  undeclaredField: number;
  unfounded: number;
}

const empty = (): Cell => ({
  episodes: 0, proposals: 0, invalid: 0, refused: 0, succeeded: 0, abstained: 0, steps: 0,
  valid: 0, offCatalogue: 0, wrongState: 0, wrongValue: 0,
  noToolCall: 0, stuck: 0, distinct: 0, distinctInvalid: 0, promptTokens: 0, completionTokens: 0,
  provSteps: 0, fixed: 0, prefilled: 0, intent: 0, undeclaredField: 0, unfounded: 0,
});

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
    k.valid += e.steps.filter((s) => s.inValidSet).length;
    k.wrongValue += e.steps.filter((s) => s.inValidSet && !s.executed).length;
    k.offCatalogue += e.steps.filter((s) => !s.inValidSet && s.proposedId === null).length;
    k.wrongState += e.steps.filter((s) => !s.inValidSet && s.proposedId !== null).length;
    // `duplicate` is absent from logs written before it was recorded; treating
    // those steps as distinct keeps the old denominator rather than inventing one.
    k.distinct += e.steps.filter((s) => s.duplicate !== true).length;
    k.distinctInvalid += e.steps.filter((s) => s.duplicate !== true && !s.inValidSet).length;
    if (e.stopReason === "no_tool_call") k.noToolCall++;
    if (e.stopReason === "stuck") k.stuck++;
    for (const s of e.steps) {
      if (s.tokens) {
        k.promptTokens += s.tokens.prompt;
        k.completionTokens += s.tokens.completion;
      }
      // Logs written before provenance was recorded simply contribute nothing.
      if (!s.provenance) continue;
      k.provSteps++;
      for (const f of s.provenance.fields) {
        if (f.source === "fixed") k.fixed++;
        else if (f.source === "prefilled") k.prefilled++;
        else if (f.source === "intent") k.intent++;
        else if (f.source === "asked-open" || f.source === "asked-bounded") k.undeclaredField++;
      }
      k.unfounded += s.provenance.undeclared.length;
    }
    if (e.succeeded) k.succeeded++;
    if (e.stopReason === "agent_stop") k.abstained++;
  }
}

const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);

/**
 * Conditions in the canonical order, followed by any the logs contain that the
 * current design does not name. Older runs used earlier names, and silently
 * dropping their rows would make a log look empty rather than out of date.
 */
function ordered(byCond: Map<Condition, Map<string, Cell>>): Condition[] {
  const known = CONDITIONS.filter((c) => byCond.has(c));
  const extra = [...byCond.keys()].filter((c) => !CONDITIONS.includes(c)).sort();
  return [...known, ...extra];
}

if (asLatex) {
  console.log("% invalid action rate / task success, by condition. H is 0 BY CONSTRUCTION.");
  for (const [model, byCond] of table) {
    for (const c of ordered(byCond)) {
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
    console.log("cond  class  eps  props  invalid  invalid*   refused   success   abstain   steps/ep");
    for (const c of ordered(byCond)) {
      const byClass = byCond.get(c);
      if (!byClass) continue;
      for (const klass of ["all", "T1", "T2", "T3"]) {
        const k = byClass.get(klass);
        if (!k) continue;
        console.log(
          `${c.padEnd(5)} ${klass.padEnd(6)} ${String(k.episodes).padStart(3)} ` +
            `${String(k.proposals).padStart(6)} ${pct(k.invalid, k.proposals).padStart(8)} ` +
            `${pct(k.distinctInvalid, k.distinct).padStart(9)} ` +
            `${pct(k.refused, k.proposals).padStart(9)} ${pct(k.succeeded, k.episodes).padStart(9)} ` +
            `${pct(k.abstained, k.episodes).padStart(9)} ${(k.steps / k.episodes).toFixed(1).padStart(10)}`,
        );
      }
      console.log("");
    }

    // ── the value side ───────────────────────────────────────────────────────
    // Two questions the invalid-action rate cannot answer: where did the values
    // come from, and did naming a legal action actually suffice?
    // ── how the invalid proposals were invalid ───────────────────────────────
    console.log("      invalid proposals ──────────────");
    console.log("cond   off-catalogue   wrong-state   (of invalid)");
    for (const c of ordered(byCond)) {
      const k = byCond.get(c)?.get("all");
      if (!k) continue;
      console.log(
        `${c.padEnd(5)} ${String(k.offCatalogue).padStart(9)} ${pct(k.offCatalogue, k.invalid).padStart(8)}` +
          ` ${String(k.wrongState).padStart(8)} ${pct(k.wrongState, k.invalid).padStart(8)}` +
          `   ${k.invalid} invalid`,
      );
    }
    console.log(
      "\n  off-catalogue = the named thing does not exist; the model invented it. Only P\n" +
        "                  (a url nothing serves) and X / X+ (a tool never offered) can\n" +
        "                  express this; picking an index out of a list cannot.\n" +
        "  wrong-state   = a real operation, issued where the state does not allow it.\n",
    );

    console.log("       steps    values submitted ─────────────────────   right action,");
    console.log("cond   w/prov   fixed  prefill   intent  undecl  unfnd   wrong value");
    for (const c of ordered(byCond)) {
      const k = byCond.get(c)?.get("all");
      if (!k) continue;
      console.log(
        `${c.padEnd(5)} ${`${k.provSteps}/${k.proposals}`.padStart(8)} ` +
          `${String(k.fixed).padStart(7)} ${String(k.prefilled).padStart(8)} ` +
          `${String(k.intent).padStart(8)} ${String(k.undeclaredField).padStart(7)} ` +
          `${String(k.unfounded).padStart(6)}   ${String(k.wrongValue).padStart(4)} of ${String(k.valid).padStart(4)} valid ` +
          `${pct(k.wrongValue, k.valid).padStart(7)}`,
      );
    }
    console.log(
      "\n  w/prov = steps carrying provenance; logs predating it count as proposals but\n" +
        "           contribute no values, so read the value columns against this, not props.\n" +
        "  fixed/prefill = the surface carried the value   intent = the model supplied it\n" +
        "  undecl = nobody did, so the harness stood in for the user\n" +
        "  unfnd  = model supplied a field the control never declared (unfounded elicitation)\n" +
        "  wrong value = action was legal here, but the value was refused anyway",
    );

    // ── cost, and the protocol's own failure mode ────────────────────────────
    console.log("\n       tokens ────────────────────────────    no tool call");
    console.log("cond     prompt  completion     total   /ep    (X / X+ only)");
    for (const c of ordered(byCond)) {
      const k = byCond.get(c)?.get("all");
      if (!k) continue;
      const total = k.promptTokens + k.completionTokens;
      console.log(
        `${c.padEnd(5)} ${String(k.promptTokens).padStart(9)} ${String(k.completionTokens).padStart(11)} ` +
          `${String(total).padStart(9)} ${(total / (k.episodes || 1)).toFixed(0).padStart(6)}   ` +
          `${String(k.noToolCall).padStart(6)} ${pct(k.noToolCall, k.episodes).padStart(7)}` +
          `   ${String(k.stuck).padStart(5)} ${pct(k.stuck, k.episodes).padStart(7)}`,
      );
    }
    console.log(
      "\n  invalid  = over every proposal (per decision, as the benchmarks define it)\n" +
        "  invalid* = over DISTINCT (state, request) attempts only — a repeat of a request\n" +
        "             already refused from an unmoved state is counted once. Where the two\n" +
        "             diverge, the condition's rate is few mistakes held for a long time\n" +
        "             rather than many mistakes.\n",
    );

    console.log(
      "  tokens are summed over every step AND every reprompt, so a condition that\n" +
        "  needs re-asking is charged for it. Zero means the backend reported no usage\n" +
        "  (the random floor makes no model call at all).\n" +
        "  no tool call = the model answered in neither the protocol nor the stop token.\n" +
        "                 A measurement, not a harness fault; cf. NTC in the benchmarks.",
    );
  }
  console.log(
    "\nnote: invalid = 0 is a STRUCTURAL GUARANTEE in every condition whose offered set is\n" +
      "      narrowed to the current state — H and X+ both. The agent acts on a set that\n" +
      "      contains only legal actions, so no other value is expressible. Only J, J+, X\n" +
      "      and P measure anything in that column.\n" +
      "note: H and X+ are therefore NOT separated by it, and are not meant to be. What\n" +
      "      separates them is the value side: X+ names the parameters an operation takes,\n" +
      "      H carries the values the current state gives them. Read the value table for\n" +
      "      that, and the wrong-value column in particular.\n" +
      "note: H wrong-value = 0 is structural too — a declared value is only rendered where\n" +
      "      it is legal, so the value and its legality share one source. X+'s is not: it\n" +
      "      must produce the value itself, and what a model produces can be wrong.\n" +
      "note: J+ vs X is the protocol cell. Same operations, same descriptions, same\n" +
      "      parameters; one is read as text and chosen by index, the other is served by\n" +
      "      a real MCP server and invoked by a native tool call. A gap here would mean\n" +
      "      the comparison is about the protocol; its absence is what licenses reading\n" +
      "      X -> X+ as being about state-dependence.",
  );
}
