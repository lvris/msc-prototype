/**
 * surface.ts — the ONE thing that differs between experimental conditions.
 *
 * Every condition runs the same loop, the same chooser, the same prompt template
 * and the same HTTP replay. The only variable is where the `AVAILABLE ACTIONS:`
 * block comes from:
 *
 *   H   discover(html)  — the server-rendered set, which narrows with the state
 *   J   CATALOGUE       — all 21 endpoints, fixed, as a tool-calling agent gets them
 *   J+  CATALOGUE+note  — the same list plus each precondition stated in prose
 *
 * The `CURRENT PAGE:` block is `describe(html)` in ALL THREE conditions, word for
 * word. Withholding the page from J would confound "closed action set" with "can
 * see the state at all", and the thesis claims the former.
 */

import type { Affordance, AffordanceField, Method } from "../a/affordance.ts";
import { discover } from "../a/discover.ts";
import { CATALOGUE, type CatalogueEntry } from "../b1/catalogue.ts";

export type Condition = "H" | "J" | "J+";
export const CONDITIONS: Condition[] = ["H", "J", "J+"];

/**
 * A catalogue entry as an Affordance. Params become required text fields with no
 * prefilled value — a static catalogue knows the parameter names but never the
 * values the current state would have supplied, which is precisely the difference
 * from a rendered control carrying `slot=20:00` in a hidden input.
 */
function toAffordance(e: CatalogueEntry, withNote: boolean): Affordance {
  const fields: AffordanceField[] = e.params.map((p) => ({ name: p, type: "text", required: true }));
  return {
    method: e.method as Method,
    url: e.url,
    fields,
    label: withNote && e.note ? `${e.description} ${e.note}` : e.description,
    source: "native",
  };
}

export const catalogueSurface = (withNote: boolean): Affordance[] =>
  CATALOGUE.map((e) => toAffordance(e, withNote));

export function surfaceFor(condition: Condition, html: string): Affordance[] {
  return condition === "H" ? discover(html) : catalogueSurface(condition === "J+");
}
