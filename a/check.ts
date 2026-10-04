/**
 * check.ts — self-check of A's engine (discover + replay) against a running site.
 *
 * Everything here goes through A's own perception: fetch HTML, call `discover()`
 * to get the action set, act by `replay()`. The site is never imported; the only
 * privileged thing this harness does is ask the site, over HTTP, what it believes
 * the valid action set to be, so the two can be compared. That comparison is the
 * thesis property from the agent's side:
 *
 *   A1  A's discovered set is EXACTLY the site's valid set — no missed control,
 *       no phantom control — over every state the walk reaches.
 *   A2  an action ruled out by the site's state is ABSENT from A's set, not
 *       refused after the fact. A cannot express it, so it cannot mis-fire.
 *   A3  affordance identity includes field VALUES: five "hold" forms differing
 *       only in a hidden slot are five affordances, not one (regression).
 *   A4  A carries no site-specific knowledge: nothing under a/ names the site.
 *
 * The same set has a second consumer, and its claims are checked here too:
 *
 *   R1  there is NO MODEL in the rendering path — asserted against render.ts's
 *       own source, since that is what the claim is about.
 *   R2  one affordance renders to exactly one control, deterministically.
 *   R3  the declared fields survive rendering: each becomes either something the
 *       user may set or something the control fixes, and never both.
 *
 * Requires a running site (`A_BASE`, default http://localhost:3000).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Affordance, affordanceKey } from "./affordance.ts";
import { discover } from "./discover.ts";
import { render, renderControl } from "./render.ts";
import { prepareValues, replay } from "./replay.ts";

export {};

const BASE = process.env.A_BASE ?? "http://localhost:3000";

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

// ── the site's own account of itself (harness endpoint, never rendered) ───────

/** Whatever the site calls its state; A never inspects this, only the harness does. */
type SiteState = Record<string, unknown>;

interface Truth {
  session: SiteState;
  /** the site's valid set, in the same normalized shape A discovers. */
  valid: { id: string; method: string; url: string; fields?: { name: string; value?: string }[] }[];
  /** every action the site can ever perform. */
  all: string[];
}

const truth = async (): Promise<Truth> =>
  (await fetch(`${BASE}/__session`)).json() as Promise<Truth>;

const pin = async (state: SiteState): Promise<void> => {
  await fetch(`${BASE}/__session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
};

const truthKey = (a: Truth["valid"][number]): string =>
  `${a.method} ${a.url} [${(a.fields ?? []).map((f) => `${f.name}=${f.value ?? ""}`).sort().join(",")}]`;

const html = (): Promise<string> => fetch(`${BASE}/`).then((r) => r.text());

// ── A1 + A2 over a breadth-first walk of the site ────────────────────────────

section("A1 — what A discovers is exactly what the site holds valid");

/** Identity of a visited state, from the harness's point of view. */
function stateId(s: SiteState): string {
  const { bookingId: _drop, ...rest } = s;
  return JSON.stringify(rest);
}

/** Values A supplies for fields the HTML leaves blank — ordinary user input. */
const USER_VALUES: Record<string, string> = {
  name: "Ada Lovelace",
  phone: "+358 40 123 4567",
  card: "4242 4242 4242 4242",
  reason: "Travel plans changed.",
};

/**
 * A cap, not a claim: this walk keys states by raw session JSON, so it does not
 * terminate on its own (a pre-order can always grow another dish). Exhaustive
 * coverage of the state space is the site checker's job; here the point is that
 * perception and validity agree wherever the walk goes.
 */
const MAX_STATES = 400;
const seen = new Set<string>();
const queue: SiteState[] = [];

await pin({}); // fresh session
const first = (await truth()).session;
seen.add(stateId(first));
queue.push(first);

let comparisons = 0;
/** every control the walk perceived, so R2/R3 can be asserted over all of them. */
const allPerceived: Affordance[] = [];
while (queue.length > 0 && seen.size < MAX_STATES) {
  const state = queue.shift()!;
  await pin(state);
  const t = await truth();
  const perceived = discover(await html());
  allPerceived.push(...perceived);

  // A1: both inclusions, keyed by (method, url, field name=value).
  const mine = new Set(perceived.map(affordanceKey));
  const theirs = new Set(t.valid.map(truthKey));
  for (const k of theirs) assert(mine.has(k), `A1 A discovers the valid action ${k}`);
  for (const k of mine) assert(theirs.has(k), `A1 A discovers nothing invalid: ${k}`);
  comparisons++;

  // A2: an action the state rules out is ABSENT, not merely refused. Anything in
  // the site's full action list whose url does not appear in A's set is simply
  // not something A can choose.
  const validUrls = new Set(t.valid.map((a) => `${a.method} ${a.url}`));
  const perceivedUrls = new Set(perceived.map((a) => `${a.method} ${a.url}`));
  for (const u of perceivedUrls) {
    assert(validUrls.has(u), `A2 [${t.session.status}] A can express only valid actions (${u})`);
  }
  assert(
    perceived.length === t.valid.length,
    `A2 [${t.session.status}] A's action set is the whole valid set and nothing else`,
  );

  // expand
  for (const a of perceived) {
    await pin(state);
    const res = await replay(a, prepareValues(a, USER_VALUES), BASE);
    assert(!res.refused, `A2 a discovered action is never refused: ${affordanceKey(a)}`);
    const next = (await truth()).session;
    const id = stateId(next);
    if (!seen.has(id)) {
      seen.add(id);
      queue.push(next);
    }
  }
}
console.log(
  `  compared A's perception with the site's valid set in ${comparisons} states ` +
    `(walk capped at ${MAX_STATES} distinct sessions)`,
);

// ── A2 (pointed): the gated-away action is absent, not refused ───────────────

section("A2 — gated actions are absent from A's set");

interface GateCase {
  name: string;
  state: SiteState;
  /** urls A must NOT be able to express here, though the site can perform them elsewhere. */
  absent: string[];
  present: string[];
}

const draft = (partySize: number, status: string): SiteState => ({
  status,
  date: "next-week",
  partySize,
  slot: "19:00",
  guest: { name: "Ada", phone: "+358" },
  preorder: { status: "none", dishes: [] },
});

const cases: GateCase[] = [
  {
    name: "G1 large party: no plain confirm, only the deposit",
    state: draft(8, "deposit_pending"),
    absent: ["POST /confirm"],
    present: ["POST /deposit"],
  },
  {
    name: "G2 close to seating: no outright cancel, only a request",
    state: { ...draft(2, "confirmed"), date: "tomorrow", bookingId: "R00001" },
    absent: ["DELETE /booking"],
    present: ["POST /cancellation-request"],
  },
  {
    name: "G3 confirmed booking: the pre-order window has closed",
    state: { ...draft(2, "confirmed"), bookingId: "R00001" },
    absent: ["POST /preorder", "POST /preorder/dishes"],
    present: ["GET /confirmation"],
  },
  {
    name: "G4 fully booked date: no hold, only the waitlist",
    state: { status: "browsing", date: "saturday", partySize: 2, preorder: { status: "none", dishes: [] } },
    absent: ["POST /hold"],
    present: ["POST /waitlist"],
  },
  {
    name: "G5 unconfirmed draft: discard exists, cancel does not",
    state: draft(2, "details_entered"),
    absent: ["DELETE /booking", "POST /cancellation-request"],
    present: ["DELETE /draft"],
  },
];

for (const c of cases) {
  await pin(c.state);
  const perceived = discover(await html());
  const urls = new Set(perceived.map((a) => `${a.method} ${a.url}`));
  for (const u of c.absent) assert(!urls.has(u), `A2 ${c.name}: ${u} is absent`);
  for (const u of c.present) assert(urls.has(u), `A2 ${c.name}: ${u} is offered`);
  console.log(`  ${c.name}\n    A sees: ${[...urls].join(", ")}`);
}

// ── A3 — identity includes field values ─────────────────────────────────────

section("A3 — controls differing only in a hidden value stay distinct");

await pin({ status: "browsing", date: "next-week", partySize: 2, preorder: { status: "none", dishes: [] } });
const browsing = discover(await html());
const holds = browsing.filter((a) => a.method === "POST" && a.url === "/hold");
const holdKeys = new Set(holds.map(affordanceKey));
assert(holds.length > 1, `A3 several hold controls are present (got ${holds.length})`);
assert(holdKeys.size === holds.length, `A3 they do not collapse into one (${holdKeys.size} distinct keys)`);
const hiddenValues = new Set(holds.map((a) => a.fields.find((f) => f.name === "slot")?.value));
assert(hiddenValues.size === holds.length, `A3 each carries its own hidden value: ${[...hiddenValues].join(", ")}`);

// ── R1 — no model in the rendering path ─────────────────────────────────────
//
// The design chapter says a control can be drawn directly from an affordance,
// "with no model in the rendering path and no task-specific component registry".
// That is a claim about this codebase, so it is checked against the source rather
// than trusted. Comments are stripped first: render.ts's own header explains at
// length that there is no model in it, and a scan of the raw text would flag the
// documentation of the property as a violation of it.

section("R1 — the renderer is a pure function of the affordance");

const here = dirname(fileURLToPath(import.meta.url));
const renderSrc = readFileSync(join(here, "render.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

const imports = [...renderSrc.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
const before = failures.length;
assert(
  imports.length === 1 && imports[0] === "./affordance.ts",
  `R1 render.ts imports only the affordance shape (got: ${imports.join(", ") || "none"})`,
);
for (const forbidden of ["fetch(", "choose", "Chooser", "model", "prompt", "await "]) {
  assert(!renderSrc.includes(forbidden), `R1 render.ts contains no "${forbidden}"`);
}
if (failures.length === before) {
  console.log(`  render.ts: 1 import, no i/o, no chooser, nothing asynchronous`);
}

// ── R2 — one affordance, one control ────────────────────────────────────────

section("R2 — rendering is one-for-one with the affordance set");

const controls = render(allPerceived);
assert(controls.length === allPerceived.length, `R2 no control is invented or dropped`);
for (let i = 0; i < allPerceived.length; i++) {
  assert(
    controls[i].key === affordanceKey(allPerceived[i]),
    `R2 control ${i} keeps its affordance's identity`,
  );
}
// Rendering the same affordance twice must give the same control: no hidden
// state, no counter, no randomness anywhere in the path.
for (const a of allPerceived.slice(0, 200)) {
  assert(
    JSON.stringify(renderControl(a)) === JSON.stringify(renderControl(a)),
    `R2 rendering is deterministic: ${affordanceKey(a)}`,
  );
}
console.log(`  rendered ${controls.length} controls from ${allPerceived.length} affordances`);

// ── R3 — the fields survive rendering ───────────────────────────────────────

section("R3 — every declared field is accounted for, and nothing else appears");

let widgets = 0;
let fixedValues = 0;
let degraded = 0;
for (let i = 0; i < allPerceived.length; i++) {
  const a = allPerceived[i];
  const c = controls[i];
  const declared = [...a.fields.map((f) => f.name)].sort();
  const accounted = [...c.widgets.map((w) => w.field), ...Object.keys(c.fixed)].sort();
  assert(
    JSON.stringify(declared) === JSON.stringify(accounted),
    `R3 ${c.key}: fields in == fields out (${declared.join(",")} vs ${accounted.join(",")})`,
  );
  // A field is EITHER the user's or the control's, never both: a value the
  // control fixes must not also be presented as something to fill in.
  for (const w of c.widgets) {
    assert(!(w.field in c.fixed), `R3 ${c.key}: ${w.field} is not both fixed and editable`);
  }
  widgets += c.widgets.length;
  fixedValues += Object.keys(c.fixed).length;
  degraded += c.widgets.filter((w) => w.degraded).length;
}
console.log(
  `  ${widgets} widgets + ${fixedValues} values fixed by their control; ` +
    `${degraded} field(s) fell back to a text box`,
);

// ── A4 — A carries no site-specific knowledge ───────────────────────────────

section("A4 — nothing under a/ names a site");

const SITE_NAMES = /\bb[0-9]+\b/;
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}
for (const file of walk(here)) {
  const hit = readFileSync(file, "utf8").split("\n").findIndex((l) => SITE_NAMES.test(l));
  assert(hit === -1, `A4 ${file.slice(here.length + 1)} names no site (line ${hit + 1})`);
}

// ── A5 — nobody on the client side reads the harness's oracle ────────────────

/**
 * `GET /__session` returns `validAffordances(session)` — the answer the whole
 * evaluation is measuring. The site is allowed to consult it — its renderer and
 * its own tool server both do, and a server knowing its own state is the
 * premise rather than the conclusion. Anything on the CLIENT side reading it
 * would be the harness supplying the result it claims to observe.
 *
 * The risk is sharpest for the MCP conditions. X+ is narrow because the SERVER
 * narrowed `tools/list`; if `exp/mcp-client.ts` peeked at the session instead,
 * X+ would measure our code rather than the protocol. So that one file is
 * checked alongside `a/`, even though it lives in `exp/`.
 *
 * Comments are stripped first. Both files DISCUSS the oracle by name in prose —
 * including the paragraph you are reading — and a raw scan would convict them of
 * the thing the prose promises they do not do.
 *
 * This file is excluded from its own scan, and that is not a loophole. A checker
 * for "nobody names this endpoint" has to name the endpoint, in code, to look
 * for it; and `check.ts` is not part of what the agent runs. The claim is about
 * the agent's runtime modules, and those are what is scanned.
 */
section("A5 — the client side never reads the harness oracle");

const ORACLE = /__session/;
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const clientSide = [
  ...walk(here).filter((f) => !f.endsWith("check.ts")),
  join(here, "..", "exp", "mcp-client.ts"),
];
for (const file of clientSide) {
  const hit = stripComments(readFileSync(file, "utf8"))
    .split("\n")
    .findIndex((l) => ORACLE.test(l));
  assert(hit === -1, `A5 ${file.replace(/\\/g, "/").split("/").slice(-2).join("/")} does not read /__session`);
}

// ── summary ─────────────────────────────────────────────────────────────────

console.log(
  `\n${failures.length === 0 ? `ALL ${passed} CHECKS PASSED` : `${failures.length} CHECK(S) FAILED (${passed} passed)`}`,
);
process.exit(failures.length === 0 ? 0 : 1);
