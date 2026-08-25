/**
 * check.ts — the site invariant checker.
 *
 * These are not ordinary unit tests. Each invariant is the executable form of a
 * claim the thesis makes about hypermedia-constrained interaction, asserted over
 * EVERY reachable state rather than over a hand-picked scenario:
 *
 *   I1  rendered == valid    the controls parsed out of the representation are
 *                            exactly `validAffordances(s)` — both inclusions.
 *   I2  guard refuses        every catalogued action outside the valid set is
 *                            refused (409) and leaves the state untouched.
 *   I3  offered == doable    every rendered control, replayed as declared,
 *                            succeeds and (if mutating) moves the state.
 *   I4  reachability         every status is reachable from a fresh session,
 *                            and the checker prints the path.
 *   I5  fields are complete  the declared fields suffice to build a successful
 *                            request; no hidden required parameter exists.
 *   I6  the gates bite       for G1..G5, the two sides of the gate really do
 *                            expose different action sets.
 *
 * The state space comes from `explore.ts`, which walks the site through controls
 * it discovered in HTML — so the walk is itself evidence that the site is
 * navigable by perception alone.
 */

import { CATALOGUE, SAMPLE_VALUES } from "./catalogue.ts";
import {
  affordanceKey,
  controlKey,
  exec,
  explore,
  extract,
  fullKey,
  getSession,
  pageHtml,
  setSession,
  startSite,
} from "./explore.ts";
import {
  ALL_ACTION_IDS,
  CANCEL_WINDOW_HOURS,
  DATES,
  freshSession,
  insideCancelWindow,
  LARGE_PARTY,
  MENU,
  type Session,
  type Status,
  validAffordances,
} from "./model.ts";

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

await startSite();

// ── the walk ─────────────────────────────────────────────────────────────────

section("Exploring the state space through the site's own controls");

const graph = await explore();
assert(graph.complete, "the walk closed on its own rather than hitting the state cap");
console.log(`  visited ${graph.nodes.size} states over ${graph.edges.length} transitions`);
const perStatus = new Map<string, number>();
for (const n of graph.nodes.values()) {
  perStatus.set(n.session.status, (perStatus.get(n.session.status) ?? 0) + 1);
}
for (const [status, count] of [...perStatus].sort()) console.log(`    ${status}: ${count}`);
if (process.env.VERBOSE) {
  for (const n of graph.nodes.values()) {
    console.log(`    ${n.key}\n      ← ${n.path.length ? n.path.join(" → ") : "(fresh session)"}`);
  }
}

// ── I1: rendered == valid, in every state ────────────────────────────────────

section("I1 — the representation offers exactly the valid action set");

for (const node of graph.nodes.values()) {
  await setSession(node.session);
  const modelKeys = new Set(validAffordances(node.session).map(affordanceKey));
  const renderedKeys = new Set(extract(await pageHtml()).map(controlKey));
  for (const k of modelKeys) assert(renderedKeys.has(k), `I1 [${node.key}] valid is rendered: ${k}`);
  for (const k of renderedKeys) assert(modelKeys.has(k), `I1 [${node.key}] rendered is valid: ${k}`);
}
console.log(`  both inclusions hold in all ${graph.nodes.size} states`);

// ── I3 + I5: from the edges the walk actually executed ───────────────────────

section("I3 + I5 — every offered control is executable, with the fields it declares");

for (const e of graph.edges) {
  const what = `${e.control.method} ${e.control.url} (${e.control.label})`;
  // I5: a 400 means a required parameter was never mentioned in the HTML.
  assert(e.status !== 400, `I5 [${e.from}] ${what} needs no undeclared field`);
  // I3: an offered control is executable at the moment it is offered.
  assert(e.status < 400, `I3 [${e.from}] ${what} executes (got ${e.status})`);
  if (e.status < 400 && e.control.method !== "GET") {
    assert(e.moved, `I3 [${e.from}] ${what} moves the state`);
  }
}
console.log(`  ${graph.edges.length} offered controls executed, none refused`);

// ── I2: everything outside the valid set is refused and changes nothing ──────

section("I2 — catalogued actions outside the valid set are refused");

let refusals = 0;
for (const node of graph.nodes.values()) {
  const validIds = new Set(validAffordances(node.session).map((a) => a.id));
  for (const entry of CATALOGUE) {
    if (validIds.has(entry.id)) continue;
    await setSession(node.session);
    const values: Record<string, string> = {};
    for (const p of entry.params) values[p] = SAMPLE_VALUES[p] ?? "x";
    const res = await exec(entry.method, entry.url, values);
    assert(res.status === 409, `I2 [${node.key}] ${entry.id} refused (got ${res.status})`);
    const after = await getSession();
    assert(
      fullKey(after) === fullKey(node.session),
      `I2 [${node.key}] ${entry.id} left the state untouched`,
    );
    refusals++;
  }
}
console.log(`  ${refusals} out-of-state requests, all refused with 409 and no state change`);

// ── I4: reachability of every declared status and every action ───────────────

section("I4 — every status is reachable, with a witness path");

const ALL_STATUSES: Status[] = [
  "browsing",
  "holding",
  "details_entered",
  "deposit_pending",
  "confirmed",
  "conflict",
  "waitlisted",
  "cancelled",
  "cancellation_requested",
];

for (const status of ALL_STATUSES) {
  const hit = [...graph.nodes.values()].find((n) => n.session.status === status);
  assert(hit !== undefined, `I4 ${status} is reachable from a fresh session`);
  if (hit) console.log(`  ${status}: ${hit.path.length ? hit.path.join(" → ") : "(fresh session)"}`);
}

section("I4b — every catalogued action is valid in at least one reachable state");
const everValid = new Set<string>();
for (const n of graph.nodes.values()) for (const a of validAffordances(n.session)) everValid.add(a.id);
for (const id of ALL_ACTION_IDS) assert(everValid.has(id), `I4b ${id} is valid in some reachable state`);

// ── I6: the gates bite ───────────────────────────────────────────────────────

section("I6 — the two sides of each gate expose different action sets");

const idsFor = (s: Session): Set<string> => new Set(validAffordances(s).map((a) => a.id));

function gate(
  name: string,
  left: Session,
  right: Session,
  expect: { onlyLeft: string[]; onlyRight: string[] },
): void {
  const l = idsFor(left);
  const r = idsFor(right);
  for (const id of expect.onlyLeft) assert(l.has(id) && !r.has(id), `I6 ${name}: ${id} on one side only`);
  for (const id of expect.onlyRight) assert(r.has(id) && !l.has(id), `I6 ${name}: ${id} on the other side only`);
  console.log(`  ${name}: {${[...l].join(", ")}}  vs  {${[...r].join(", ")}}`);
}

const draft = (partySize: number): Session => ({
  ...freshSession(),
  status: partySize > LARGE_PARTY ? "deposit_pending" : "details_entered",
  date: "next-week",
  partySize,
  slot: "19:00",
  guest: { name: "Ada", phone: "+358" },
});

const booked = (date: string): Session => ({
  ...freshSession(),
  status: "confirmed",
  date,
  partySize: 2,
  slot: "19:00",
  guest: { name: "Ada", phone: "+358" },
  bookingId: "R00001",
});

// G1 — the deposit threshold
gate("G1 deposit threshold", draft(LARGE_PARTY), draft(LARGE_PARTY + 1), {
  onlyLeft: ["confirm_booking", "open_preorder"],
  onlyRight: ["pay_deposit"],
});

// G2 — the cancellation window
const far = DATES.find((d) => d.hoursUntilSeating > CANCEL_WINDOW_HOURS)!;
const near = DATES.find((d) => d.hoursUntilSeating <= CANCEL_WINDOW_HOURS)!;
gate("G2 cancellation window", booked(far.id), booked(near.id), {
  onlyLeft: ["cancel_booking"],
  onlyRight: ["request_cancellation"],
});
assert(!insideCancelWindow(booked(far.id)), `I6 G2: ${far.id} is outside the window`);
assert(insideCancelWindow(booked(near.id)), `I6 G2: ${near.id} is inside the window`);

// G3 — the pre-order window
const openPre: Session = { ...draft(2), preorder: { status: "open", dishes: [MENU[0]] } };
const submittedPre: Session = { ...draft(2), preorder: { status: "submitted", dishes: [MENU[0]] } };
gate("G3 pre-order open vs submitted", openPre, submittedPre, {
  onlyLeft: ["add_dish", "remove_dish", "submit_preorder"],
  onlyRight: [],
});
assert(!idsFor(booked(far.id)).has("open_preorder"), "I6 G3: a confirmed booking cannot open a pre-order");
assert(
  !idsFor({ ...draft(2), status: "holding" }).has("open_preorder"),
  "I6 G3: a merely held table cannot open a pre-order",
);

// G4 — the waitlist is non-monotonic
const fullDate = DATES.find((d) => d.taken.length === 5)!;
const browsingFull: Session = { ...freshSession(), date: fullDate.id, partySize: 2 };
const browsingFree: Session = { ...freshSession(), date: far.id, partySize: 2 };
gate("G4 full vs free date", browsingFree, browsingFull, {
  onlyLeft: ["hold_slot"],
  onlyRight: ["join_waitlist"],
});
const queued: Session = { ...browsingFull, status: "waitlisted", waitlistPosition: 3 };
const queuedPolled: Session = { ...queued, waitlistPolled: true, waitlistPosition: 1 };
gate("G4 waitlist before vs after a release", queued, queuedPolled, {
  onlyLeft: [],
  onlyRight: ["hold_slot"],
});

// G5 — "cancel" is not one action
gate("G5 discard vs cancel", draft(2), booked(far.id), {
  onlyLeft: ["discard_draft"],
  onlyRight: ["cancel_booking"],
});
gate("G5 discard vs request cancellation", draft(2), booked(near.id), {
  onlyLeft: ["discard_draft"],
  onlyRight: ["request_cancellation"],
});

// ── how much does a static catalogue over-offer? ─────────────────────────────

section("Catalogue-to-valid ratio");
const sizes = [...graph.nodes.values()].map((n) => validAffordances(n.session).length);
const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
console.log(
  `  ${CATALOGUE.length} catalogued actions; valid per state: min ${Math.min(...sizes)}, ` +
    `max ${Math.max(...sizes)}, mean ${mean.toFixed(2)} → ratio ${(CATALOGUE.length / mean).toFixed(1)}:1`,
);

// ── summary ──────────────────────────────────────────────────────────────────

console.log(
  `\n${failures.length === 0 ? `ALL ${passed} CHECKS PASSED` : `${failures.length} CHECK(S) FAILED (${passed} passed)`}`,
);
process.exit(failures.length === 0 ? 0 : 1);
