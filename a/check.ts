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
 * Requires a running site (`A_BASE`, default http://localhost:3000).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { affordanceKey } from "./affordance.ts";
import { discover } from "./discover.ts";
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
while (queue.length > 0 && seen.size < MAX_STATES) {
  const state = queue.shift()!;
  await pin(state);
  const t = await truth();
  const perceived = discover(await html());

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

// ── A4 — A carries no site-specific knowledge ───────────────────────────────

section("A4 — nothing under a/ names a site");

const here = dirname(fileURLToPath(import.meta.url));
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

// ── summary ─────────────────────────────────────────────────────────────────

console.log(
  `\n${failures.length === 0 ? `ALL ${passed} CHECKS PASSED` : `${failures.length} CHECK(S) FAILED (${passed} passed)`}`,
);
process.exit(failures.length === 0 ? 0 : 1);
