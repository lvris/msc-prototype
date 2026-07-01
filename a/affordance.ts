/**
 * affordance.ts — the normalized shape A reduces every control to.
 *
 * This is the load-bearing abstraction of the thesis: A never carries a
 * site-specific business id. An affordance is identified purely by what the HTML
 * itself declares — `(method, url, fields, label)`. The same shape is produced by
 * the native and htmx parsers, so a new site vocabulary means one more parser, not
 * new agent knowledge.
 */

export type Method = "GET" | "POST" | "PUT" | "DELETE";

/** One input the control declares. Its value comes from HTML, the goal, or the user — never invented. */
export interface AffordanceField {
  name: string;
  /** input type, or "select" / "textarea". */
  type: string;
  required: boolean;
  /** a prefilled / hidden value already in the HTML. */
  value?: string;
  /** enumerated choices for a <select>. */
  options?: string[];
  label?: string;
}

export interface Affordance {
  method: Method;
  /** action target as written in the HTML (may be relative; resolved at replay). */
  url: string;
  fields: AffordanceField[];
  /** the human-visible text of the control (button / link text). */
  label: string;
  source: "native" | "htmx";
}

/**
 * A stable identity for dedupe/logging: method + url + each field's name=value.
 * Values matter: two controls posting to the same url with a different hidden
 * value (e.g. `slot=19:00` vs `slot=20:00`) are DISTINCT affordances, not one.
 */
export function affordanceKey(a: Affordance): string {
  const fields = a.fields.map((f) => `${f.name}=${f.value ?? ""}`).sort().join(",");
  return `${a.method} ${a.url} [${fields}]`;
}
