/**
 * htmx.ts — parser for htmx's hypermedia extension.
 *
 * htmx's `hx-*` are self-describing ATTRIBUTES, readable without executing any
 * JavaScript (the htmx runtime only matters for a human browser). They
 * re-standardize exactly what native HTML can't: verbs beyond GET/POST, and
 * arbitrary-element triggers. A reads them to discover a control's method/url,
 * then replays the equivalent plain HTTP request.
 *
 * `hx-target`/`hx-swap` are presentation-only (which fragment the browser would
 * replace) and are ignored — A always reads the full-page response.
 */

import type { Affordance, Method } from "../affordance.ts";
import { collectFields, type Queryable, text } from "./dom.ts";

const VERBS: Method[] = ["GET", "POST", "PUT", "DELETE"];

export function parseHtmx(root: Queryable): Affordance[] {
  const out: Affordance[] = [];

  for (const el of root.querySelectorAll("[hx-get], [hx-post], [hx-put], [hx-delete]")) {
    let method: Method | undefined;
    let url: string | undefined;
    for (const v of VERBS) {
      const u = el.getAttribute(`hx-${v.toLowerCase()}`);
      if (u !== null) {
        method = v;
        url = u;
        break;
      }
    }
    if (!method || url === undefined) continue;

    // hx-include="closest form" → the enclosing form's inputs are what gets sent,
    // so the request stays reconstructible from the HTML alone.
    let fields: Affordance["fields"] = [];
    const include = el.getAttribute("hx-include");
    if (include && /closest\s+form/.test(include)) {
      const form = el.closest?.("form") ?? null;
      if (form) fields = collectFields(form);
    }

    out.push({ method, url, fields, label: text(el), source: "htmx" });
  }

  return out;
}
