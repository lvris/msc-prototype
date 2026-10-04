/**
 * tasks.ts — derive the task set from the state machine.
 *
 * The tasks are not chosen. They fall out of the reachability graph produced by
 * `explore.ts`, under three rules that partition every (start state, intent) pair
 * by what the correct behaviour actually is:
 *
 *   T1  exposed      some action satisfying the intent is valid right here.
 *                    Correct behaviour: do it. Note this is not trivial — under
 *                    G1/G2 the valid member of the intent group is not the one an
 *                    action catalogue makes obvious.
 *   T2  elsewhere    no such action is valid here, but one becomes valid in a
 *                    state reachable without giving up the current booking.
 *                    Correct behaviour: get there first, then act.
 *   T3  impossible   no such action is valid in any state reachable without
 *                    giving up the current booking.
 *                    Correct behaviour: say so, and act on nothing.
 *
 * Reachability deliberately excludes the actions that throw the booking away
 * (see ABANDONING). Otherwise every goal is trivially reachable — `start_over`
 * makes the graph strongly connected — and "can the guest still do this?" would
 * always answer yes, which is not what anyone means by the question.
 *
 * That partition is the point. T1 rewards acting, T2 punishes acting immediately,
 * T3 punishes acting at all. A policy that fires the most plausible tool for the
 * stated goal scores well on T1 only when the obvious action happens to be the
 * valid one, while a policy constrained to the rendered controls cannot fire an
 * invalid action in any class. Hand-picked tasks could be accused of being chosen
 * to produce exactly that; derived ones cannot.
 *
 * Run: `npm run b1:tasks` → prototype/exp/tasks.json (+ a table on stdout).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOGUE } from "./catalogue.ts";
import { explore, type Graph, type Node, startSite } from "./explore.ts";
import { type Intent, INTENTS } from "./goals.ts";
import { type ActionId, type Session, validAffordances } from "./model.ts";

export {};

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Actions that give up whatever the guest currently holds. Paths through them are
 * not "how to reach the goal" — they are "start over and hope", which is what T3
 * asks the agent to refuse to do.
 */
const ABANDONING: ActionId[] = [
  "start_over",
  "discard_draft",
  "release_hold",
  "change_slot",
  "leave_waitlist",
];

/**
 * How many of each class. Enough to cover every gate from both sides without the
 * set turning into a benchmark in its own right; selection within a class is by
 * shortest witness, so it is reproducible and never a judgement call.
 */
const QUOTA = { T1: 10, T2: 8, T3: 6 } as const;

await startSite();
const graph: Graph = await explore();
if (!graph.complete) throw new Error("the walk hit its state cap; the task set would be incomplete");

const nodes = [...graph.nodes.values()];
const validIds = new Map<string, Set<ActionId>>();
for (const n of nodes) {
  validIds.set(n.key, new Set(validAffordances(n.session).map((a) => a.id as ActionId)));
}

/** Which action id sits behind a control, for classifying edges. Method+url is unique. */
const idByEndpoint = new Map(CATALOGUE.map((e) => [`${e.method} ${e.url}`, e.id]));

/** Edges that keep the current booking alive, as an adjacency list. */
const keepAdjacency = new Map<string, { to: string; label: string }[]>();
for (const e of graph.edges) {
  if (e.status >= 400) continue;
  const id = idByEndpoint.get(`${e.control.method} ${e.control.url}`);
  if (id && ABANDONING.includes(id)) continue;
  const list = keepAdjacency.get(e.from) ?? [];
  list.push({ to: e.to, label: `${e.control.method} ${e.control.url}` });
  keepAdjacency.set(e.from, list);
}

const satisfiedHere = (key: string, intent: Intent): boolean =>
  intent.actions.some((a) => validIds.get(key)?.has(a));

/** Shortest booking-preserving route from `from` to a state that satisfies `intent`. */
function routeTo(from: string, intent: Intent): string[] | undefined {
  const queue: { key: string; path: string[] }[] = [{ key: from, path: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const { key, path } = queue.shift()!;
    if (path.length > 0 && satisfiedHere(key, intent)) return path;
    for (const { to, label } of keepAdjacency.get(key) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push({ key: to, path: [...path, label] });
    }
  }
  return undefined;
}

const depth = (n: Node): number => n.path.length;
const byDepth = (a: Node, b: Node): number => depth(a) - depth(b) || a.key.localeCompare(b.key);

// ── the tasks ────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  class: "T1" | "T2" | "T3";
  /** what the guest wants, in words — this is all the agent is told. */
  goalText: string;
  intent: string;
  /** every action that would satisfy the intent; scoring only, never shown. */
  satisfiedBy: ActionId[];
  /** the subset of those that are actually valid at the start state (empty for T2/T3). */
  validHere: ActionId[];
  startState: Session;
  startKey: string;
  /** how the harness reaches the start state, for the record. */
  startPath: string[];
  /** for T2: the shortest booking-preserving route to a state that satisfies the goal. */
  routeToGoal?: string[];
  expectedUnderH: string;
}

const tasks: Task[] = [];
const serial = new Map<string, number>();
function push(t: Omit<Task, "id">): void {
  const n = (serial.get(t.class) ?? 0) + 1;
  serial.set(t.class, n);
  tasks.push({ ...t, id: `${t.class}-${String(n).padStart(2, "0")}` });
}

interface Candidate {
  node: Node;
  intent: Intent;
  route?: string[];
}

const t1: Candidate[] = [];
const t2: Candidate[] = [];
const t3: Candidate[] = [];

for (const node of [...nodes].sort(byDepth)) {
  for (const intent of INTENTS) {
    if (satisfiedHere(node.key, intent)) {
      t1.push({ node, intent });
      continue;
    }
    const route = routeTo(node.key, intent);
    if (route) t2.push({ node, intent, route });
    else t3.push({ node, intent });
  }
}

/**
 * Reduce candidates to one per `key`, then fill the quota, always taking the
 * candidate from the least-used start status first and breaking ties by cost
 * (route length, then depth). The status spread matters: without it the whole set
 * clusters on whichever state happens to sit nearest the root, and a task set
 * that only ever starts from `browsing` would test nothing about the gates.
 */
function pick(candidates: Candidate[], quota: number, key: (c: Candidate) => string): Candidate[] {
  const cost = (c: Candidate): number => (c.route?.length ?? 0) * 100 + depth(c.node);

  /**
   * A candidate discriminates when the intent has more than one satisfying action
   * and the one that is valid here is NOT the first one a catalogue lists — the
   * large party that must pay a deposit rather than confirm, the booking inside
   * the 24-hour window that must be requested rather than cancelled. An agent
   * picking the plausible tool for the stated goal gets these wrong; an agent
   * reading the rendered controls cannot. They come first, ahead of the spread
   * over start states, because they are the whole reason the gates exist.
   */
  const discriminating = (c: Candidate): number => {
    if (c.intent.actions.length < 2) return 1;
    const here = c.intent.actions.filter((a) => validIds.get(c.node.key)!.has(a));
    return here.length === 1 && here[0] !== c.intent.actions[0] ? 0 : 1;
  };

  const best = new Map<string, Candidate>();
  for (const c of candidates) {
    const prev = best.get(key(c));
    if (!prev || cost(c) < cost(prev)) best.set(key(c), c);
  }
  const pool = [...best.values()].sort(
    (a, b) => discriminating(a) - discriminating(b) || cost(a) - cost(b) || key(a).localeCompare(key(b)),
  );

  const chosen: Candidate[] = [];
  const used = new Map<string, number>();
  /**
   * How many tasks each INTENT has already contributed.
   *
   * Without this the quota fills by cost once the discriminating candidates are
   * exhausted, and cost correlates with depth — so the set piles up on the
   * intents nearest the root and leaves others with no task at all. The first
   * derivation covered ten start states but only eight intents, and the ones it
   * dropped (`add_dish`, `secure_table`, `start_preorder`) are exactly the ones
   * whose actions take a value the server constrains. A task set that never asks
   * for a dish cannot observe anything about supplying a dish.
   *
   * Ranked after `discriminating`, which stays first: the gates are the reason
   * the state machine exists, and covering the action space must not cost the
   * two cases the whole design was built to produce.
   */
  const perIntent = new Map<string, number>();
  while (chosen.length < quota) {
    const next = pool
      .filter((c) => !chosen.includes(c))
      .sort(
        (a, b) =>
          discriminating(a) - discriminating(b) ||
          (perIntent.get(a.intent.id) ?? 0) - (perIntent.get(b.intent.id) ?? 0) ||
          (used.get(a.node.session.status) ?? 0) - (used.get(b.node.session.status) ?? 0) ||
          cost(a) - cost(b),
      )[0];
    if (!next) break;
    chosen.push(next);
    used.set(next.node.session.status, (used.get(next.node.session.status) ?? 0) + 1);
    perIntent.set(next.intent.id, (perIntent.get(next.intent.id) ?? 0) + 1);
  }
  return chosen;
}

/**
 * T1 is keyed by intent AND by which member of the intent satisfies it here, so
 * an intent with alternatives yields one task per alternative. That is what puts
 * "confirm the booking" in front of a large party (where only `pay_deposit` is
 * valid) as well as a small one, and "cancel the booking" on both sides of the
 * 24-hour window — the two cases the whole design exists to produce.
 */
const byIntent = (c: Candidate): string => c.intent.id;
const byIntentAndAction = (c: Candidate): string =>
  `${c.intent.id}:${c.intent.actions.filter((a) => validIds.get(c.node.key)!.has(a)).join("+")}`;

const common = (c: Candidate): Omit<Task, "id" | "class" | "expectedUnderH"> => ({
  goalText: c.intent.goal,
  intent: c.intent.id,
  satisfiedBy: c.intent.actions,
  validHere: c.intent.actions.filter((a) => validIds.get(c.node.key)!.has(a)),
  startState: c.node.session,
  startKey: c.node.key,
  startPath: c.node.path,
  routeToGoal: c.route,
});

for (const c of pick(t1, QUOTA.T1, byIntentAndAction)) {
  push({
    ...common(c),
    class: "T1",
    expectedUnderH: "a control satisfying the goal is rendered; the agent executes it",
  });
}
for (const c of pick(t2, QUOTA.T2, byIntent)) {
  push({
    ...common(c),
    class: "T2",
    expectedUnderH:
      "no such control is rendered here; the agent must first reach a state that renders one",
  });
}
for (const c of pick(t3, QUOTA.T3, byIntent)) {
  push({
    ...common(c),
    class: "T3",
    expectedUnderH:
      "no such control is rendered in any state reachable without giving up the booking; " +
      "the agent must report the goal as unattainable",
  });
}

// ── output ───────────────────────────────────────────────────────────────────

const outDir = join(HERE, "..", "exp");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "tasks.json"),
  JSON.stringify(
    {
      generatedFrom: {
        states: graph.nodes.size,
        transitions: graph.edges.length,
        candidates: { T1: t1.length, T2: t2.length, T3: t3.length },
        abandoning: ABANDONING,
      },
      tasks,
    },
    null,
    2,
  ) + "\n",
);

const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
console.log(
  `\nDerived ${tasks.length} tasks from ${graph.nodes.size} states / ${graph.edges.length} transitions` +
    ` (candidates: T1 ${t1.length}, T2 ${t2.length}, T3 ${t3.length})\n`,
);
console.log(`  ${pad("id", 6)} ${pad("start state", 40)} ${pad("goal", 44)} valid here / route`);
for (const t of tasks) {
  const tail =
    t.class === "T1"
      ? `→ ${t.validHere.join(", ")}`
      : t.class === "T2"
        ? `via ${t.routeToGoal?.join(" → ")}`
        : "(unreachable without abandoning the booking)";
  console.log(
    `  ${pad(t.id, 6)} ${pad(t.startKey.split("|").slice(0, 4).join("|"), 40)} ${pad(t.goalText, 44)} ${tail}`,
  );
}
console.log(`\nwrote ${join(outDir, "tasks.json")}`);
process.exit(0);
