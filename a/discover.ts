/**
 * discover.ts — turn one returned representation into the current valid action set.
 *
 * Parse the HTML once, run both vocabulary parsers over it, and dedupe. The
 * resulting list IS the closed set A may act within: whatever chooses the next
 * action (user, rule, model) can only pick from here, so an action the server did
 * not render is not merely unlikely — it is inexpressible.
 */

import { parseHTML } from "linkedom";
import { type Affordance, affordanceKey } from "./affordance.ts";
import type { Queryable } from "./parse/dom.ts";
import { parseHtmx } from "./parse/htmx.ts";
import { parseNative } from "./parse/native.ts";

export function discover(html: string): Affordance[] {
  const { document } = parseHTML(html);
  const root = document as unknown as Queryable;

  const seen = new Set<string>();
  const out: Affordance[] = [];
  for (const a of [...parseNative(root), ...parseHtmx(root)]) {
    const key = affordanceKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}
