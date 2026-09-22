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
import type { Choice, Chooser, Usage } from "../a/choose.ts";
import { describe } from "../a/describe.ts";
import { prepareValues } from "../a/replay.ts";
import { entryFor, SAMPLE_VALUES } from "../b1/catalogue.ts";
import { stateKey } from "../b1/explore.ts";
import type { ActionId } from "../b1/model.ts";
import { actionIdOf, resetTo, snapshot } from "./judge.ts";
import { classify, type Provenance } from "./provenance.ts";
import { type Condition, CONSTRUCTS, type Surfacer, TOOLCALL } from "./surface.ts";

export const MAX_STEPS = 20;

/**
 * How many times the identical refused request is recorded before the episode
 * is cut. Three: the first observation, plus two that confirm the state really
 * has not moved underneath it. Applied identically in every condition, so it
 * cannot advantage one — it only stops one of them from being charged twenty
 * proposals for a single fact.
 */
export const STUCK_LIMIT = 3;

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
  /** the server performed the action (status < 400). */
  executed: boolean;
  httpStatus: number | null;
  /**
   * The server declined. Note this is NOT the complement of `executed`: a request
   * can fail with 400 because its VALUES were unacceptable (an empty card, a dish
   * that is not on the menu) while the action itself was perfectly legal here.
   * Keeping the two apart is what lets "wrong action" and "right action, wrong
   * value" be counted as the different mistakes they are.
   */
  refused: boolean;
  satisfiedGoal: boolean;
  /** where each submitted value came from, and what an interface would have had to ask. */
  provenance: Provenance;
  /**
   * The values actually submitted.
   *
   * `provenance` says where each value CAME FROM; this says what it WAS. The
   * difference matters for the failure the evaluation calls "right action,
   * wrong value": without the value there is no way to tell, from the log
   * alone, whether the server refused a dish it does not serve or a dish it
   * serves under another spelling. Recorded verbatim, before the server sees
   * it.
   */
  values: Record<string, string>;
  /**
   * The tool name the model emitted, under X / X+ only. Recorded verbatim,
   * including names that were never offered: `proposedId === null` together with
   * a non-null `toolName` is a hallucinated tool, which is a different mistake
   * from a real operation fired in the wrong state.
   */
  toolName: string | null;
  /** tokens spent on this decision, when the backend reports them. */
  tokens: Usage | null;
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
  /**
   * Tool-calling only: the model produced neither a tool call nor the stop
   * token, twice. Kept apart from `agent_stop` because declining to act and
   * failing to answer in the protocol are different behaviours, and apart from
   * `chooser_error` because this one is a measurement rather than a fault — it
   * is the no-tool-call rate the benchmark literature reports.
   */
  | "no_tool_call"
  /**
   * The same request was refused from the same state `STUCK_LIMIT` times over.
   *
   * This is not the harness reasoning on the agent's behalf. The site is a
   * function of (state, request): if a request was refused and the state did not
   * move, the next identical attempt is refused for the same reason, and so is
   * the one after that. Letting it run to the step cap does not observe anything
   * twenty times — it observes one thing and records it twenty times, which
   * inflates every per-proposal rate in favour of whichever condition happens to
   * get stuck. Cutting the loop declines the duplicate, nothing more.
   */
  | "stuck"
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

/**
 * Values to submit: HTML defaults, then the chooser's, then a sample per name.
 *
 * The last step stands in for a human. A required field that neither the control
 * nor the goal supplies is exactly where a real interface would put a question to
 * the user; a batch run cannot block on one, so it fills the value and carries on.
 * `classify` records what it stood in for, so the substitution is measured rather
 * than silent — see provenance.ts.
 */
function fill(
  a: Affordance,
  provided: Record<string, string>,
): { values: Record<string, string>; provenance: Provenance } {
  const provenance = classify(a, provided);
  const values = prepareValues(a, provided);
  for (const f of a.fields) {
    if (values[f.name] !== undefined && values[f.name] !== "") continue;
    if (!f.required) continue;
    values[f.name] = f.options?.length ? f.options[0] : (SAMPLE_VALUES[f.name] ?? "x");
  }
  return { values, provenance };
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
  surfacer: Surfacer;
  model: string;
  temperature: number;
  runId: string;
}): Promise<EpisodeRecord> {
  const { base, task, condition, chooser, surfacer, model, temperature, runId } = opts;
  const steps: StepRecord[] = [];
  const history: string[] = [];
  /** identical (state, request) attempts that the server refused — see STUCK_LIMIT. */
  const repeats = new Map<string, number>();
  let stopReason: StopReason = "step_cap";
  let succeeded = false;
  let abandoned = false;
  let error: string | undefined;

  await resetTo(base, task.startState);

  const constructing = CONSTRUCTS.has(condition);
  const toolCalling = TOOLCALL.has(condition);
  if (constructing && !chooser.construct) {
    return {
      runId, condition, model, temperature,
      taskId: task.id, taskClass: task.class, intent: task.intent,
      steps: [], stopReason: "chooser_error", succeeded: false, abandoned: false,
      error: `backend "${chooser.name}" cannot construct requests; condition ${condition} needs it`,
    };
  }

  for (let step = 1; step <= MAX_STEPS; step++) {
    const html = await fetch(`${base}/`).then((r) => r.text());
    const snap = await snapshot(base);
    const surface = await surfacer.for(condition, { html });
    const affs = surface.affordances;
    const state = describe(html);

    if (!constructing && affs.length === 0) {
      stopReason = "no_actions";
      break;
    }

    let choice: Choice;
    try {
      const ctx = {
        goal: task.goalText,
        step,
        state,
        affordances: affs,
        history,
        ...(constructing ? { document: html } : {}),
        ...(surface.tools ? { tools: surface.tools } : {}),
      };
      /**
       * Three ways to decide, and the fallback matters.
       *
       * A tool-calling condition uses the protocol when the backend speaks it.
       * When it does not — the random floor makes no model call at all — the
       * step falls back to selecting from the SAME offered set by index rather
       * than being skipped. A backend with no reasoning has no protocol to
       * speak, and what it scores under X+ is scored by the constraint alone,
       * which is the one number that separates constraint from capability.
       */
      choice = toolCalling && chooser.callTool
        ? await chooser.callTool(ctx)
        : constructing
          ? await chooser.construct!(ctx)
          : await chooser.choose(ctx);
    } catch (e) {
      stopReason = "chooser_error";
      error = (e as Error).message;
      break;
    }
    const provided = choice.values;

    if (choice.noToolCall) {
      stopReason = "no_tool_call";
      break;
    }

    /**
     * The control this step exercises. The model may have selected one from a
     * set the server authored, named one by tool name, or built one out of the
     * page; all three are wrapped in the same shape so that everything
     * downstream — value provenance, execution, judging — treats them
     * identically. The asymmetry is confined to this block, which is where it
     * belongs.
     */
    let chosen: Affordance;
    let toolName: string | null = choice.toolName ?? null;
    if (choice.toolName !== undefined) {
      const i = surface.tools?.findIndex((t) => t.name === choice.toolName) ?? -1;
      chosen =
        i >= 0
          ? affs[i]
          : {
              // A tool that was never offered. It is turned into a request to a
              // path that does not exist, so it 404s and `actionIdOf` returns
              // null — the same off-catalogue outcome a made-up url gets under
              // P. Resolving it to the nearest real tool would erase the error.
              method: "POST",
              url: `/${choice.toolName}`,
              fields: [],
              label: `called an unoffered tool: ${choice.toolName}`,
              source: "native",
            };
    } else if (choice.action) {
      chosen = {
        method: choice.action.method,
        url: choice.action.url,
        fields: [],
        label: `${choice.action.method} ${choice.action.url}`,
        source: "native",
      };
    } else {
      const index = choice.index;
      if (index < 0 || index >= affs.length) {
        stopReason = "agent_stop";
        break;
      }
      chosen = affs[index];
    }
    const proposedId = actionIdOf(chosen, base);

    /**
     * A constructed request declares no fields, which would starve it of the
     * value backstop every other condition gets.
     *
     * `fill` tops up required fields a chooser left empty from `SAMPLE_VALUES`,
     * standing in for the user an interface would have asked. With `fields: []`
     * there is nothing to top up, so P alone had to supply every value itself
     * or be refused — and the same underlying event (`card` unsupplied) was
     * being booked as an elicitation demand under H and as a wrong value under
     * P. Recovering the declared parameters for a request that DID name a real
     * endpoint puts the two back on one footing. A request that named nothing
     * real keeps `fields: []`: there are no parameters to know, and bearing
     * that cost is what constructing an endpoint out of thin air means.
     */
    if (chosen.fields.length === 0 && proposedId !== null) {
      const entry = entryFor(proposedId);
      if (entry) {
        chosen = {
          ...chosen,
          fields: entry.params.map((p) => ({ name: p, type: "text", required: true })),
        };
      }
    }
    const inValidSet = proposedId === null ? false : snap.validIds.includes(proposedId);
    const { values, provenance } = fill(chosen, provided);
    const res = await exec(base, chosen, values);
    const refused = res.status === 409;
    // A goal is reached only if the server actually performed the action. Testing
    // `!refused` would credit a 400 — the model naming the right operation and
    // submitting a value the server would not take — as success, which is exactly
    // the failure the value-side comparison is trying to expose.
    const ok = res.status < 400;
    const satisfiedGoal = ok && proposedId !== null && task.satisfiedBy.includes(proposedId);

    steps.push({
      step,
      stateKey: stateKey(snap.session),
      validIds: snap.validIds,
      offered: affs.length,
      proposedId,
      proposedLabel: chosen.label,
      inValidSet,
      executed: ok,
      httpStatus: res.status,
      refused,
      satisfiedGoal,
      provenance,
      values,
      toolName,
      tokens: choice.usage ?? null,
    });
    /**
     * The history line names the action the way the condition named it: by tool
     * name where the model called a tool, by control otherwise. Rewriting one
     * into the other would put words in the model's mouth and, under X, would
     * paste a full tool description into every subsequent prompt.
     */
    history.push(
      (toolName !== null ? toolName : `${chosen.method} ${chosen.url} (${chosen.label})`) +
        (ok ? "" : refused ? " — refused" : ` — rejected (${res.status})`),
    );

    // Giving up the booking only disqualifies a run when it was a detour. Some
    // goals ARE abandoning edges (change the time, leave the queue), and firing
    // the very action the task asks for is never "abandonment".
    if (ok && proposedId !== null && ABANDONING.has(proposedId) && !satisfiedGoal) {
      abandoned = true;
    }

    if (satisfiedGoal) {
      stopReason = abandoned ? "goal_via_abandon" : "goal_satisfied";
      succeeded = stopReason === "goal_satisfied";
      break;
    }

    // Keyed on the state as well as the request: the same request from a state
    // that HAS moved is a different observation and resets nothing.
    const attempt = `${stateKey(snap.session)}|${chosen.method} ${chosen.url}|${new URLSearchParams(values).toString()}`;
    if (ok) {
      repeats.clear();
    } else {
      const n = (repeats.get(attempt) ?? 0) + 1;
      repeats.set(attempt, n);
      if (n >= STUCK_LIMIT) {
        stopReason = "stuck";
        break;
      }
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
