/**
 * elicitation-scan.ts — the interface-side cost of each surface, without a model.
 *
 * Two of the evaluation's numbers do not depend on which model is chosen, how it
 * reasons, or whether it succeeds. They follow from the SHAPE of the action
 * information a surface provides, and can therefore be computed over the entire
 * reachable state space in one pass:
 *
 *   OVER-OFFER      of the controls a surface would put in front of the user,
 *                   how many are not valid in the current state? Under H this is
 *                   zero by construction — the surface IS the valid set. Under a
 *                   catalogue it is whatever the catalogue over-offers, and the
 *                   user is looking at buttons that do nothing.
 *
 *   ELICITATION     for the same action in the same state, how many values does
 *                   the surface DECLARE, and how many would have to come from
 *                   somewhere else? A rendered control arrives with `slot=20:00`
 *                   inside the control that uses it; the catalogue entry for the
 *                   same action knows only that a parameter called `slot` exists.
 *
 * The comparison is deliberately per (state, action): same state, same action,
 * two surfaces. Aggregating over actions would let the catalogue's over-offering
 * leak into the elicitation figure and confound the two.
 *
 * ⚠️ READ THE ELICITATION FIGURE AS A FLOOR, AND ONLY FOR J.
 *
 * `surface.ts` gives every condition the same `describe(html)` block, word for
 * word — withholding the page from J would confound "closed action set" with
 * "can see the state at all". So J is NOT blind to the free slots: it can read
 * "19:00 is free" from the page prose and supply the value itself.
 *
 * What this scan measures is therefore DECLARED vs INFERRED, not known vs
 * unknown. It holds the chooser at zero (`provided` is empty throughout), so:
 *
 *   H's figure is model-independent and firm. Its values come from the control
 *     itself, so no chooser can change them.
 *   J's figure is a floor. A real model recovers some of these values from the
 *     page, and how many is an empirical question about that model.
 *
 * The two are not the same kind of number and must not be read as one row. The
 * measured elicitation gap comes from the runs, where `episode.ts` records each
 * value's origin per step; this scan bounds it, it does not predict it.
 *
 * The difference that survives inference is the interesting one. A declared value
 * cannot be wrong: `slot=19:00` is inside a control the server rendered, and it
 * rendered that control only because 19:00 is free. An inferred value can be
 * wrong, costs a round trip of reasoning, and nothing checks it — see the
 * "valid action, wrong value" column in `report.ts`.
 *
 * Usage:  pnpm exp:elicitation [--states N | --states all]
 */

import type { Affordance } from "../a/affordance.ts";
import { discover } from "../a/discover.ts";
import { renderControl } from "../a/render.ts";
import { BASE, explore, pageHtml, setSession, startSite } from "../b1/explore.ts";
import { type ActionId, validAffordances } from "../b1/model.ts";
import { actionIdOf } from "./judge.ts";
import { type ElicitationCounts, classify, count, sum } from "./provenance.ts";
import { catalogueSurface } from "./surface.ts";

export {}; // module, so top-level await is allowed

const section = (t: string): void => console.log(`\n# ${t}`);

const arg = process.argv[process.argv.indexOf("--states") + 1];
const wantStates = arg === "all" ? Infinity : Number(arg) || 200;

await startSite();

section("Walking the site");
const graph = await explore();
const all = [...graph.nodes.values()];
const stride = Math.max(1, Math.ceil(all.length / wantStates));
const sample = all.filter((_, i) => i % stride === 0);
console.log(`  ${all.length} reachable states; scanning ${sample.length} (stride ${stride})`);

// The catalogue surface is state-independent by definition, so it is built once.
const CATALOGUE_SURFACE = catalogueSurface(false);

// ── over-offer ───────────────────────────────────────────────────────────────

let hOffered = 0;
let hInvalid = 0;
let jOffered = 0;
let jInvalid = 0;

// ── elicitation, per (state, action) pair present in both surfaces ───────────

const hCounts: ElicitationCounts[] = [];
const jCounts: ElicitationCounts[] = [];
let pairs = 0;

/**
 * The figures above are counted from `classify`, which reads the affordance. What
 * the thesis reports them as, though, is a property of the CONTROLS A PRESENTS —
 * and those come from `render`, a different function in a different module.
 *
 * The two must agree, or the numbers are about something other than the interface
 * the user sees. `render` assigns each field a `demand`; `classify` assigns each
 * field a `source`. Neither knows about the other. Asserting the correspondence
 * over every affordance the walk encounters is what lets the elicitation figures
 * be read as facts about the rendered surface rather than about an intermediate
 * data structure.
 */
const DEMAND_FOR: Record<string, string> = {
  fixed: "fixed",
  prefilled: "prefilled",
  "asked-open": "asked",
  "asked-bounded": "asked",
  omitted: "optional",
};
let agreements = 0;
const disagreements: string[] = [];

function crossCheck(a: Affordance): void {
  const c = renderControl(a);
  const demandOf = new Map<string, string>();
  for (const w of c.widgets) demandOf.set(w.field, w.demand);
  for (const k of Object.keys(c.fixed)) demandOf.set(k, "fixed");

  for (const f of classify(a, {}).fields) {
    const expected = DEMAND_FOR[f.source];
    const actual = demandOf.get(f.field);
    if (expected === actual) agreements++;
    else disagreements.push(`${c.key} ${f.field}: classify=${f.source} → ${expected}, render=${actual}`);
  }
}

/** Which field names drive the must-ask figure, so the classifier is auditable. */
const hAsked = new Map<string, number>();
const jAsked = new Map<string, number>();
const tallyAsked = (into: Map<string, number>, p: { fields: { field: string; source: string }[] }): void => {
  for (const f of p.fields) {
    if (f.source === "asked-open" || f.source === "asked-bounded") {
      into.set(f.field, (into.get(f.field) ?? 0) + 1);
    }
  }
};

for (const node of sample) {
  await setSession(node.session);
  const html = await pageHtml();

  const valid = new Set<ActionId>(validAffordances(node.session).map((a) => a.id as ActionId));
  const rendered = discover(html);

  // over-offer: how much of each surface is dead in this state
  for (const a of rendered) {
    hOffered++;
    const id = actionIdOf(a, BASE);
    if (id === null || !valid.has(id)) hInvalid++;
  }
  for (const a of CATALOGUE_SURFACE) {
    jOffered++;
    const id = actionIdOf(a, BASE);
    if (id === null || !valid.has(id)) jInvalid++;
  }

  // elicitation: for every action valid HERE, compare the two surfaces' controls
  // for it. Several rendered controls can share an action id (one `hold_slot` per
  // free slot); the first is taken, since they differ only in the fixed value and
  // so carry identical provenance.
  for (const id of valid) {
    const h = rendered.find((a) => actionIdOf(a, BASE) === id);
    const j = CATALOGUE_SURFACE.find((a) => actionIdOf(a, BASE) === id);
    if (!h || !j) continue;
    const hp = classify(h, {});
    const jp = classify(j, {});
    hCounts.push(count(hp));
    jCounts.push(count(jp));
    tallyAsked(hAsked, hp);
    tallyAsked(jAsked, jp);
    crossCheck(h);
    crossCheck(j);
    pairs++;
  }
}

// ── report ───────────────────────────────────────────────────────────────────

const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);

section("Over-offer: controls presented that are not valid in the current state");
console.log(`  H  (server-rendered)  ${hInvalid} of ${hOffered} offered   ${pct(hInvalid, hOffered)}`);
console.log(`  J  (static catalogue) ${jInvalid} of ${jOffered} offered   ${pct(jInvalid, jOffered)}`);
console.log(
  `\n  per state: H offers ${(hOffered / sample.length).toFixed(2)} controls, ` +
    `${(hInvalid / sample.length).toFixed(2)} of them dead;\n` +
    `             J offers ${(jOffered / sample.length).toFixed(2)} controls, ` +
    `${(jInvalid / sample.length).toFixed(2)} of them dead.`,
);
console.log(
  `\n  NOTE: H's zero is a STRUCTURAL GUARANTEE, not a measurement — the surface is\n` +
    `  the valid set, so the two cannot differ. Only J's figure is measured. The\n` +
    `  thesis must carry this caveat wherever the number appears.`,
);

section("Values the surface declares, per (state, action) pair");
const h = sum(hCounts);
const j = sum(jCounts);
console.log(`  ${pairs} pairs — the same action, in the same state, under each surface.`);
console.log(
  `  both surfaces declare ${h.declared} fields in total` +
    `${h.declared === j.declared ? " (identical)" : ` vs ${j.declared}`}` +
    `: the catalogue lists exactly the\n  parameters each endpoint takes, so the surfaces differ only in whether they\n  CARRY values, not in how many they name.\n`,
);

const row = (label: string, c: ElicitationCounts): void => {
  console.log(
    `  ${label.padEnd(22)} fixed ${String(c.fixed).padStart(4)} (${pct(c.fixed, c.declared).padStart(6)})   ` +
      `prefilled ${String(c.prefilled).padStart(4)} (${pct(c.prefilled, c.declared).padStart(6)})   ` +
      `undeclared ${String(c.mustAsk).padStart(4)} (${pct(c.mustAsk, c.declared).padStart(6)})`,
  );
};
row("H (server-rendered)", h);
row("J (static catalogue)", j);
console.log(
  `\n  fixed      = hidden field carrying a value; the control decides it and neither\n` +
    `               the model nor the user is involved.\n` +
    `  prefilled  = a default the user CAN change; the form is submittable as it stands.\n` +
    `  undeclared = required, and the surface carries no value for it. Somebody must\n` +
    `               supply one: the model by inference from the page, or the user.`,
);
console.log(
  `\n  ASYMMETRY — these two rows are not the same kind of number:\n` +
    `    H  ${pct(h.fixed + h.prefilled, h.declared)} carried is MODEL-INDEPENDENT. The values are in the control,\n` +
    `       so no chooser can change this figure.\n` +
    `    J  ${pct(j.mustAsk, j.declared)} undeclared is a FLOOR. J receives the same describe(html) as H\n` +
    `       and can recover some of these by inference; how many is empirical.\n` +
    `  The measured gap comes from the runs (episode.ts records each value's origin),\n` +
    `  not from this scan. What survives inference is that a declared value cannot be\n` +
    `  wrong, while an inferred one can — see "valid action, wrong value" in report.ts.`,
);

if (h.askedBounded + j.askedBounded === 0) {
  console.log(
    `\n  (The bounded/open split of the undeclared class is vacuous in B1: every\n` +
      `  <select> it renders carries a default, so an enumerated field is never left\n` +
      `  without a value. The distinction is kept for sites that render a choice with\n` +
      `  no default.)`,
  );
} else {
  console.log(
    `\n  of what is left undeclared, the surface still bounds the answer` +
      ` (enumerates permitted values) in:\n` +
      `    H  ${h.askedBounded} of ${h.mustAsk}   ${pct(h.askedBounded, h.mustAsk)}\n` +
      `    J  ${j.askedBounded} of ${j.mustAsk}   ${pct(j.askedBounded, j.mustAsk)}`,
  );
}

console.log(
  `\n  undeclared fields per action:  H ${(h.mustAsk / pairs).toFixed(2)}   J ${(j.mustAsk / pairs).toFixed(2)}` +
    `   (×${j.mustAsk === 0 ? "—" : (j.mustAsk / Math.max(h.mustAsk, 1)).toFixed(1)})` +
    `\n  — i.e. per action, J leaves that many more values for the model to infer or\n` +
    `    the interface to ask for. How many the model actually recovers is measured\n` +
    `    in the runs, not here.`,
);

section("Which fields each surface leaves undeclared");
const breakdown = (label: string, m: Map<string, number>): void => {
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  ${label}`);
  if (rows.length === 0) console.log(`    (nothing)`);
  for (const [field, n] of rows) console.log(`    ${field.padEnd(12)} ${String(n).padStart(4)}`);
};
breakdown("H — only what no server could know; these must come from the user:", hAsked);
console.log("");
breakdown("J — the same four, plus values the current state already determined:", jAsked);
console.log(
  `\n  The extra fields in J are the ones the page states plainly and the catalogue\n` +
    `  cannot: which slots are free, which date and party size are in play, what is\n` +
    `  on the menu, which pre-order row is which. A model reading describe(html) can\n` +
    `  often recover them — by inference, unverified, and at the cost of being able\n` +
    `  to get them wrong. Under H they arrive inside the control that consumes them.`,
);

section("Do the counted fields and the rendered controls agree?");
if (disagreements.length === 0) {
  console.log(
    `  ${agreements} field(s) classified identically by provenance.ts and render.ts.\n` +
      `  The figures above are therefore properties of the controls A presents, not of\n` +
      `  an intermediate structure: every "undeclared" field is a question the rendered\n` +
      `  interface actually puts to the user.`,
  );
} else {
  console.log(`  ✗ ${disagreements.length} disagreement(s) — the figures do not describe the surface:`);
  for (const d of disagreements.slice(0, 10)) console.log(`    ${d}`);
}

// `startSite` leaves an express listener holding the event loop open, so the
// process would never exit on its own.
process.exit(disagreements.length === 0 ? 0 : 1);
