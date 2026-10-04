/**
 * check-judges.ts — do the two judges agree?
 *
 * The evaluation's ground truth is `validAffordances(s)`: the site renders from
 * it, the guard refuses from it, and `judge.ts` labels the agent's every move
 * from it. One function playing all three roles is efficient but circular — no
 * measurement taken through it can ever contradict it.
 *
 * This harness breaks the circle. For a sample of reachable states it computes
 * the valid set twice:
 *
 *   DECLARATIVE   `validAffordances(s)` — what the site says is available.
 *   BEHAVIOURAL   `behaviourallyAvailable(s)` — what actually goes through when
 *                 every catalogued request is fired at the running server, with
 *                 no reference to the state machine (see behavioural.ts).
 *
 * and asserts they are the same set. Agreement is what licenses the rest of the
 * evaluation to keep using the cheap declarative oracle. Disagreement is never
 * merely a bug in the harness; each direction is a named framework property
 * failing, and the report says which:
 *
 *   executed but not declared   an action the representation never offers was
 *                               nevertheless accepted  →  S1/S3 violated: the
 *                               action space is not closed after all.
 *   declared but not executable an offered control could not be exercised with
 *                               any well-formed values  →  I3 violated: the site
 *                               offers something it cannot honour.
 *
 * Usage:  pnpm exp:check-judges [--states N | --states all]
 */

import { readFileSync } from "node:fs";
import { explore, startSite } from "../b1/explore.ts";
import { ALL_ACTION_IDS, type ActionId, validAffordances } from "../b1/model.ts";
import { behaviourallyAvailable } from "./behavioural.ts";

export {}; // module, so top-level await is allowed

const failures: string[] = [];
let passed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) passed++;
  else {
    console.log(`  ✗ ${msg}`);
    failures.push(msg);
  }
}

const section = (t: string): void => console.log(`\n# ${t}`);

// ── how many states to probe ─────────────────────────────────────────────────

const arg = process.argv[process.argv.indexOf("--states") + 1];
const wantAll = arg === "all";
const wantStates = wantAll ? Infinity : Number(arg) || 100;

// ── 0. the judge is structurally independent ─────────────────────────────────
//
// The whole argument rests on behavioural.ts not having seen the answer, so that
// is asserted mechanically rather than trusted. Comments are stripped first: the
// file's header discusses `validAffordances` at length, and a naive scan of the
// raw source would flag its own documentation.

section("Independence of the behavioural judge");

const source = readFileSync(new URL("./behavioural.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

for (const forbidden of ["validAffordances", "isAffordanceValid", "getSession"]) {
  assert(!source.includes(forbidden), `behavioural.ts must not reference ${forbidden}`);
}
assert(
  !/fetch\s*\(\s*[^)]*__session[^)]*\)/.test(source),
  "behavioural.ts must not read GET /__session directly",
);
console.log(`  behavioural.ts references none of the declarative oracle's names`);

// ── 1. the state space ───────────────────────────────────────────────────────

await startSite();

section("Walking the site");
const graph = await explore();
const all = [...graph.nodes.values()];
console.log(`  ${all.length} reachable states, ${graph.edges.length} transitions`);

// Stride-sample rather than take a prefix: the walk is breadth-first, so the
// first N states would all sit near the entry point and never reach the deep
// gated ones (deposit_pending, cancellation_requested) the comparison is for.
const stride = Math.max(1, Math.ceil(all.length / wantStates));
const sample = all.filter((_, i) => i % stride === 0);
console.log(
  `  probing ${sample.length} of them (stride ${stride}) × ${ALL_ACTION_IDS.length} actions ` +
    `= ${sample.length * ALL_ACTION_IDS.length} probes`,
);

// ── 2. the comparison ────────────────────────────────────────────────────────

section("Declarative vs behavioural");

let bothAvailable = 0;
let bothUnavailable = 0;
const execNotDeclared: { state: string; id: ActionId }[] = [];
const declaredNotExec: { state: string; id: ActionId }[] = [];

const started = Date.now();
for (const node of sample) {
  const declared = new Set<ActionId>(
    validAffordances(node.session).map((a) => a.id as ActionId),
  );
  const behavioural = await behaviourallyAvailable(node.session);

  for (const id of ALL_ACTION_IDS) {
    const d = declared.has(id);
    const b = behavioural.has(id);
    if (d && b) bothAvailable++;
    else if (!d && !b) bothUnavailable++;
    else if (b) execNotDeclared.push({ state: node.key, id });
    else declaredNotExec.push({ state: node.key, id });
  }
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const cells = sample.length * ALL_ACTION_IDS.length;
const agreed = bothAvailable + bothUnavailable;
console.log(`  agree available    ${bothAvailable}`);
console.log(`  agree unavailable  ${bothUnavailable}`);
console.log(`  executed, not declared   ${execNotDeclared.length}   (S1/S3)`);
console.log(`  declared, not executable ${declaredNotExec.length}   (I3)`);
console.log(`  → ${agreed}/${cells} cells agree (${((agreed / cells) * 100).toFixed(2)}%), ${elapsed}s`);

/** Print at most a few disagreements per action id, so a systematic one is legible. */
function detail(title: string, rows: { state: string; id: ActionId }[]): void {
  if (rows.length === 0) return;
  console.log(`\n  ${title}:`);
  const byId = new Map<ActionId, string[]>();
  for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r.state]);
  for (const [id, states] of byId) {
    console.log(`    ${id} — ${states.length} state(s), e.g. ${states[0]}`);
  }
}

detail("executed but not declared", execNotDeclared);
detail("declared but not executable", declaredNotExec);

assert(
  execNotDeclared.length === 0,
  `${execNotDeclared.length} action(s) executed although the representation never offered them (S1/S3)`,
);
assert(
  declaredNotExec.length === 0,
  `${declaredNotExec.length} offered control(s) could not be executed with any declared values (I3)`,
);

// ── summary ──────────────────────────────────────────────────────────────────

section("Result");
if (failures.length === 0) {
  console.log(
    `  The behavioural judge agrees with \`validAffordances\` on all ${cells} ` +
      `(state, action) cells across ${sample.length} states.`,
  );
  console.log(
    `  The declarative oracle used by judge.ts is therefore not merely self-consistent:\n` +
      `  it matches what the running site actually does.`,
  );
}

console.log(
  `\n${failures.length === 0 ? `ALL ${passed} CHECKS PASSED` : `${failures.length} CHECK(S) FAILED (${passed} passed)`}`,
);
process.exit(failures.length === 0 ? 0 : 1);
