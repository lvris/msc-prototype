/**
 * dom.ts — the tiny DOM surface the parsers rely on, plus shared field extraction.
 *
 * A reads HTML with linkedom (a real DOM, no browser, no JS execution). We depend
 * on only a small structural slice of that DOM so the parsers stay readable and
 * strictly typed without pulling in the full lib.dom types.
 */

import type { AffordanceField } from "../affordance.ts";

export interface DomNode {
  tagName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(sel: string): DomNode | null;
  querySelectorAll(sel: string): Iterable<DomNode>;
  closest?(sel: string): DomNode | null;
}

/** Anything we can run a query against (a document or an element). */
export interface Queryable {
  querySelectorAll(sel: string): Iterable<DomNode>;
}

/** Collapse whitespace and trim an element's visible text. */
export const text = (el: DomNode | null): string =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const NON_DATA_INPUT = new Set(["submit", "button", "image", "reset"]);

/**
 * Collect the data-bearing inputs within a scope into normalized fields. Values
 * come straight from the HTML (hidden values, prefilled `value`, selected option);
 * A never invents a field that is not declared here.
 */
export function collectFields(scope: DomNode): AffordanceField[] {
  const fields: AffordanceField[] = [];
  for (const el of scope.querySelectorAll("input, select, textarea")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const tag = el.tagName.toLowerCase();
    const required = el.hasAttribute("required");
    const label = fieldLabel(el);

    if (tag === "select") {
      const options: string[] = [];
      let selected: string | undefined;
      for (const opt of el.querySelectorAll("option")) {
        const val = opt.getAttribute("value") ?? text(opt);
        options.push(val);
        if (opt.hasAttribute("selected")) selected = val;
      }
      fields.push({ name, type: "select", required, options, value: selected ?? options[0], label });
    } else if (tag === "textarea") {
      fields.push({ name, type: "textarea", required, value: text(el) || undefined, label });
    } else {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (NON_DATA_INPUT.has(type)) continue;
      fields.push({ name, type, required, value: el.getAttribute("value") ?? undefined, label });
    }
  }
  return fields;
}

/** The field's visible label: text of the enclosing <label>, if any. */
function fieldLabel(el: DomNode): string | undefined {
  const lab = el.closest?.("label") ?? null;
  const t = lab ? text(lab) : "";
  return t || undefined;
}
