/**
 * provenance.ts — where did each submitted value come from?
 *
 * The agent-side metrics ask whether the action was valid. This module asks the
 * interface-side question that sits next to it: for the control the agent chose,
 * how much did the user have to be asked?
 *
 * Every value in a submitted request has exactly one origin, and the three that
 * matter are different in kind:
 *
 *   the REPRESENTATION supplied it   a hidden or prefilled field. The control
 *                                    carries the value, so nobody is asked —
 *                                    `slot=20:00` arrives inside the form.
 *   the INTENT supplied it           the chooser derived it from the goal.
 *   nobody supplied it               the field is required and neither the
 *                                    control nor the goal has a value for it, so
 *                                    an honest interface MUST ask the user.
 *
 * That last class is the interesting one. `episode.ts` cannot block on a human,
 * so it fills those from `SAMPLE_VALUES` and continues — which means the harness
 * has been silently inventing every value the model did not think of. The filling
 * is unavoidable in a batch run; doing it unlabelled is not. Counting the class
 * turns a papered-over gap into the measurement `sec:eval:method:metrics` calls
 * elicitation demand.
 *
 * The predicted contrast is structural rather than behavioural. `surface.ts`
 * turns each catalogue parameter into a required text field with no value and no
 * options, because a static catalogue knows parameter NAMES but never the values
 * the current state would have supplied. A rendered control carries them. So a
 * catalogue-backed interface must ask the user for things a hypermedia-backed one
 * already knows — before either agent has reasoned about anything.
 *
 * `undeclared` is the mirror-image failure: a value the chooser supplied under a
 * field name the control never declared. `prepareValues` passes those through to
 * the request, so they are real, and they are exactly the "unfounded elicitation"
 * the design chapter rules out — an interface asking for something with no basis
 * in the representation.
 */

import type { Affordance } from "../a/affordance.ts";

export type ValueSource =
  /** hidden field with a declared value — the control fixes it, the user cannot change it. */
  | "fixed"
  /** non-hidden field carrying a default from the representation. */
  | "prefilled"
  /** the chooser derived it from the goal. */
  | "intent"
  /** required, nobody supplied it, but the control enumerates its permitted values. */
  | "asked-bounded"
  /** required, nobody supplied it, and the answer is free-form. */
  | "asked-open"
  /** optional and nobody supplied it; nothing is submitted and nothing is asked. */
  | "omitted";

export interface FieldProvenance {
  field: string;
  required: boolean;
  source: ValueSource;
}

export interface Provenance {
  fields: FieldProvenance[];
  /** chooser keys the control does not declare — values with no basis in the representation. */
  undeclared: string[];
  /** how many keys the chooser supplied in total. */
  provided: number;
}

/**
 * Classify every declared field of `a` given what the chooser provided.
 *
 * The precedence mirrors `prepareValues` exactly, and must keep mirroring it: a
 * hidden field is forced back to its declared value after the chooser's values
 * are merged, so `fixed` outranks `intent`; for every other field the chooser
 * overwrites the representation's default, so `intent` outranks `prefilled`.
 */
export function classify(a: Affordance, provided: Record<string, string> = {}): Provenance {
  const declared = new Set(a.fields.map((f) => f.name));
  const has = (name: string): boolean =>
    provided[name] !== undefined && provided[name] !== "";

  const fields: FieldProvenance[] = a.fields.map((f) => {
    const required = f.required === true;
    let source: ValueSource;
    if (f.type === "hidden" && f.value !== undefined) source = "fixed";
    else if (has(f.name)) source = "intent";
    else if (f.value !== undefined && f.value !== "") source = "prefilled";
    else if (!required) source = "omitted";
    else if (f.options?.length) source = "asked-bounded";
    else source = "asked-open";
    return { field: f.name, required, source };
  });

  return {
    fields,
    undeclared: Object.keys(provided).filter((k) => !declared.has(k)),
    provided: Object.keys(provided).length,
  };
}

export interface ElicitationCounts {
  declared: number;
  fixed: number;
  prefilled: number;
  intent: number;
  askedBounded: number;
  askedOpen: number;
  omitted: number;
  /** required fields the interface would have to put to the user. */
  mustAsk: number;
  /** values supplied for fields the control never declared. */
  undeclared: number;
  provided: number;
}

const ZERO: ElicitationCounts = {
  declared: 0, fixed: 0, prefilled: 0, intent: 0,
  askedBounded: 0, askedOpen: 0, omitted: 0,
  mustAsk: 0, undeclared: 0, provided: 0,
};

export function count(p: Provenance): ElicitationCounts {
  const c = { ...ZERO, declared: p.fields.length, undeclared: p.undeclared.length, provided: p.provided };
  for (const f of p.fields) {
    if (f.source === "fixed") c.fixed++;
    else if (f.source === "prefilled") c.prefilled++;
    else if (f.source === "intent") c.intent++;
    else if (f.source === "asked-bounded") c.askedBounded++;
    else if (f.source === "asked-open") c.askedOpen++;
    else c.omitted++;
  }
  c.mustAsk = c.askedBounded + c.askedOpen;
  return c;
}

export function sum(counts: ElicitationCounts[]): ElicitationCounts {
  const total = { ...ZERO };
  for (const c of counts) {
    for (const k of Object.keys(total) as (keyof ElicitationCounts)[]) total[k] += c[k];
  }
  return total;
}
