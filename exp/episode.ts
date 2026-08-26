/**
 * episode.ts — one (task × condition × model) run, recorded step by step.
 *
 * The loop is deliberately the same shape as `a/loop.ts`: read the page, build the
 * action list, let the chooser pick, replay by HTTP. It is a separate file only
 * because `a/loop.ts` is interactive (it prompts a human for missing fields) and
 * because A must stay free of any experiment or b1 code — A4 asserts that.
 *
 * Missing required values are filled from `SAMPLE_VALUES` instead of from a human,
 * so a run never blocks. That filler is condition-independent: it cannot tell the
 * agent *which* action to take, only let a chosen action be submitted.
 */

import type { Affordance } from "../a/affordance.ts";
import type { Chooser } from "../a/choose.ts";
import { describe } from "../a/describe.ts";
import { prepareValues } from "../a/replay.ts";
import { SAMPLE_VALUES } from "../b1/catalogue.ts";
import { stateKey } from "../b1/explore.ts";
import type { ActionId } from "../b1/model.ts";
import { actionIdOf, resetTo, snapshot } from "./judge.ts";
import { type Condition, surfaceFor } from "./surface.ts";

export const MAX_STEPS = 20;

export interface Task {
  id: string;
  class: "T1" | "T2" | "T3";
  goalText: string;
  intent: string;
  satisfiedBy: ActionId[];
  validHere: ActionId[];
  startState: Record<string, unknown>;
  expectedUnderH: string;
}

export interface StepRecord {
  step: number;
  stateKey: string;
  validIds: ActionId[];
  offered: number;
  proposedId: ActionId | null;
  proposedLabel: string | null;
  inValidSet: boolean | null;
  executed: boolean;
  httpStatus: number | null;
  refused: boolean;
  satisfiedGoal: boolean;
}

/**
 * Edges that give up the booking in progress. T2/T3 reachability was computed on
 * the graph with these removed (b1-plan §5), so an agent that reaches a T3 goal by
 * traversing one has not solved the task — it has destroyed the booking and then
 * done something else. The log records that separately rather than as a success.
 */
const ABANDONING: ReadonlySet<ActionId> = new Set<ActionId>([
  "start_over",
  "discard_draft",
  "release_hold",
  "change_slot",
  "leave_waitlist",
]);

export type StopReason =
  | "goal_satisfied"
  | "goal_via_abandon"
  | "agent_stop"
  | "step_cap"
  | "no_actions"
  | "chooser_error";

export interface EpisodeRecord {
  runId: string;
  condition: Condition;
  model: string;
  /** decoding temperature; 0 makes the whole episode reproducible byte for byte. */
  temperature: number;
  taskId: string;
  taskClass: Task["class"];
  intent: string;
  steps: StepRecord[];
  stopReason: StopReason;
  succeeded: boolean;
  /** an abandoning edge was executed at some point in the episode. */
  abandoned: boolean;
  error?: string;
}

/** Values to submit: HTML defaults, then the chooser's, then a sample per name. */
function fill(a: Affordance, provided: Record<string, string>): Record<string, string> {
  const values = prepareValues(a, provided);
  for (const f of a.fields) {
    if (values[f.name] !== undefined && values[f.name] !== "") continue;
    if (!f.required) continue;
    values[f.name] = f.options?.length ? f.options[0] : (SAMPLE_VALUES[f.name] ?? "x");
  }
  return values;
}

async function exec(
  base: string,
  a: Affordance,
  values: Record<string, string>,
): Promise<{ status: number }> {
  const target = new URL(a.url || "/", base);
  if (a.method === "GET") {
    for (const [k, v] of Object.entries(values)) target.searchParams.set(k, v);
    const r = await fetch(target, { redirect: "follow" });
    return { status: r.status };
  }
  const r = await fetch(target, {
    method: a.method,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
    redirect: "follow",
  });
  return { status: r.status };
}

export async function runEpisode(opts: {
  base: string;
  task: Task;
  condition: Condition;
  chooser: Chooser;
  model: string;
  temperature: number;
  runId: string;
}): Promise<EpisodeRecord> {
  const { base, task, condition, chooser, model, temperature, runId } = opts;
  const steps: StepRecord[] = [];
  const history: string[] = [];
  let stopReason: StopReason = "step_cap";
  let succeeded = false;
  let abandoned = false;
  let error: string | undefined;

  await resetTo(base, task.startState);

  for (let step = 1; step <= MAX_STEPS; step++) {
    const html = await fetch(`${base}/`).then((r) => r.text());
    const snap = await snapshot(base);
    const affs = surfaceFor(condition, html);
    const state = describe(html);

    if (affs.length === 0) {
      stopReason = "no_actions";
      break;
    }

    let index: number;
    let provided: Record<string, string>;
    try {
      const choice = await chooser.choose({ goal: task.goalText, step, state, affordances: affs, history });
      index = choice.index;
      provided = choice.values;
    } catch (e) {
      stopReason = "chooser_error";
      error = (e as Error).message;
      break;
    }

    if (index < 0 || index >= affs.length) {
      stopReason = "agent_stop";
      break;
    }

    const chosen = affs[index];
    const proposedId = actionIdOf(chosen, base);
    const inValidSet = proposedId === null ? false : snap.validIds.includes(proposedId);
    const res = await exec(base, chosen, fill(chosen, provided));
    const refused = res.status === 409;
    const satisfiedGoal =
      !refused && proposedId !== null && task.satisfiedBy.includes(proposedId);

    steps.push({
      step,
      stateKey: stateKey(snap.session),
      validIds: snap.validIds,
      offered: affs.length,
      proposedId,
      proposedLabel: chosen.label,
      inValidSet,
      executed: !refused,
      httpStatus: res.status,
      refused,
      satisfiedGoal,
    });
    history.push(`${chosen.method} ${chosen.url} (${chosen.label})${refused ? " — refused" : ""}`);

    // Giving up the booking only disqualifies a run when it was a detour. Some
    // goals ARE abandoning edges (change the time, leave the queue), and firing
    // the very action the task asks for is never "abandonment".
    if (!refused && proposedId !== null && ABANDONING.has(proposedId) && !satisfiedGoal) {
      abandoned = true;
    }

    if (satisfiedGoal) {
      stopReason = abandoned ? "goal_via_abandon" : "goal_satisfied";
      succeeded = stopReason === "goal_satisfied";
      break;
    }
  }

  // T3 tasks are unattainable without abandoning the booking: the correct
  // behaviour is to stop and report that, not to reach anything.
  if (task.class === "T3") succeeded = stopReason === "agent_stop";

  return {
    runId,
    condition,
    model,
    temperature,
    taskId: task.id,
    taskClass: task.class,
    intent: task.intent,
    steps,
    stopReason,
    succeeded,
    abandoned,
    error,
  };
}
