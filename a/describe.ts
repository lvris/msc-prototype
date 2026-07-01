/**
 * describe.ts — the human-readable content of the current representation.
 *
 * `discover()` extracts the *actions*; this extracts the *content* the user should
 * see (headings and paragraphs of the main region) so A can act as a real frontend
 * — showing "Booked! 🎉 / Confirmation #ABC123", not just a bare list of controls.
 * The same text is handed to the model chooser so it can judge the current state.
 */

import { parseHTML } from "linkedom";
import { type DomNode, text } from "./parse/dom.ts";

export function describe(html: string): string {
  const { document } = parseHTML(html);
  const doc = document as unknown as DomNode;
  const scope = doc.querySelector("main") ?? doc.querySelector("body") ?? doc;

  const parts: string[] = [];
  for (const el of scope.querySelectorAll("h1, h2, h3, p")) {
    const t = text(el);
    if (t) parts.push(t);
  }
  // de-dupe consecutive repeats (e.g. a heading echoed inside a control)
  return parts.filter((p, i) => p !== parts[i - 1]).join("\n");
}
