/**
 * check.ts — scripted self-check of A's engine (discover + replay), no readline.
 *
 * It drives the same three flows as b1/check.ts, but entirely through A's own
 * perception: it fetches HTML, calls `discover()` to get the valid affordance set,
 * picks by a generic predicate (label / method+url — never a business id), and
 * acts by `replay()`. The assertions are the thesis property from the agent side:
 * an invalid action is not merely refused, it is ABSENT from the discovered set —
 * A cannot express it.
 *
 * Requires a running B1 (`A_BASE`, default http://localhost:3000). A never imports
 * any b*; this harness only talks to it over HTTP.
 */

import type { Affordance } from "./affordance.ts";
import { discover } from "./discover.ts";
import { prepareValues, replay } from "./replay.ts";

export {};

const BASE = process.env.A_BASE ?? "http://localhost:3000";

type Pred = (a: Affordance) => boolean;
const byUrl = (method: string, url: string): Pred => (a) => a.method === method && a.url === url;
const byLabel = (needle: string): Pred => (a) => a.label.includes(needle);

class Agent {
  html = "";
  url = BASE;

  async go(u: string): Promise<Affordance[]> {
    const r = await fetch(u, { redirect: "follow" });
    this.html = await r.text();
    this.url = r.url || u;
    return this.affordances();
  }
  affordances(): Affordance[] {
    return discover(this.html);
  }
  async act(pred: Pred, values: Record<string, string> = {}): Promise<void> {
    const affs = this.affordances();
    const chosen = affs.find(pred);
    if (!chosen) throw new Error("no affordance matched — cannot act");
    const res = await replay(chosen, prepareValues(chosen, values), this.url);
    this.html = res.html;
    this.url = res.url;
  }
}

const has = (affs: Affordance[], pred: Pred): boolean => affs.some(pred);

const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures.push(msg);
}
function list(label: string, affs: Affordance[]): void {
  console.log(`  ${label}: ${affs.map((a) => `${a.method} ${a.url} (${a.label})`).join("  ") || "(none)"}`);
}

const GUEST = { name: "Ada Lovelace", phone: "+358 40 123 4567" };

// ── Scenario 1: happy path (A drives browse → hold → details → confirm) ───────
console.log("\n# Scenario 1 — A completes a booking end to end");
const agent = new Agent();
await agent.go(`${BASE}/reset`);
list("browsing", agent.affordances());
await agent.act(byUrl("GET", "/availability")); // date/partySize prefilled in HTML
list("browsing + slots", agent.affordances());
await agent.act(byLabel("Hold 19:00")); // hidden slot=19:00 comes from the control
await agent.act(byUrl("POST", "/details"), GUEST); // A supplies the guest details
await agent.act(byUrl("POST", "/confirm"));
const confirmed = agent.affordances();
list("confirmed", confirmed);
assert(has(confirmed, byUrl("DELETE", "/booking")), "confirmed offers cancel (A sees DELETE /booking)");
assert(!has(confirmed, byUrl("POST", "/hold")), "confirmed: change-slot is ABSENT — A cannot express it");
assert(!has(confirmed, byUrl("POST", "/edit-details")), "confirmed: edit is ABSENT — A cannot express it");

// ── Scenario 2: conflict — 'confirm anyway' is not in A's action set ──────────
console.log("\n# Scenario 2 — conflict: A has no 'confirm anyway' to choose");
await agent.go(`${BASE}/reset`);
await agent.act(byUrl("GET", "/availability"));
await agent.act(byLabel("Hold 20:00")); // the contended slot
await agent.act(byUrl("POST", "/details"), GUEST);
await agent.act(byUrl("POST", "/confirm")); // conflicts
const conflict = agent.affordances();
list("conflict", conflict);
assert(!has(conflict, byUrl("POST", "/confirm")), "conflict: confirm is ABSENT ('confirm anyway' inexpressible)");
assert(has(conflict, byUrl("POST", "/hold")), "conflict: A can still pick another slot (POST /hold present)");
await agent.act(byLabel("Hold 19:00")); // resolve
await agent.act(byUrl("POST", "/confirm"));
assert(has(agent.affordances(), byUrl("DELETE", "/booking")), "A resolved the conflict into a confirmed booking");

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
