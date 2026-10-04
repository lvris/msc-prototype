/**
 * describe.ts — the human-readable content of the current representation.
 *
 * `discover()` extracts the *actions*; this extracts the *content* a person
 * reading the page would take in, so A can act as a real frontend — showing
 * "Booked! 🎉 / Confirmation #ABC123", not a bare list of controls. The same text
 * is handed to the model chooser in EVERY experimental condition, word for word,
 * so that the conditions differ in their action information and in nothing else.
 *
 * THAT LAST SENTENCE IS WHY THE ELEMENT LIST MATTERS. An earlier version took
 * only `h1, h2, h3, p`, which sounds like "the prose" but is not: a page states
 * plenty in list items and table cells, and this site does — the dishes already
 * on a pre-order, and which sittings are taken. Dropping those did not weaken
 * every condition equally. H reads its state through the controls it discovers,
 * which carry the same facts as field values, so H lost nothing; the catalogue
 * and tool conditions lost the only copy they had. A missing `<li>` therefore
 * went straight into the measured gap, on the side that flatters the thesis.
 *
 * So the rule is: everything a reader would read, and nothing a reader would
 * operate. Block-level text is content. What lives INSIDE a control — an
 * `<option>`'s label, a button's caption, a hidden input's value — is the
 * action information, and which conditions receive it is precisely the
 * manipulated variable. Putting it here would hand every condition the
 * hypermedia and leave nothing to compare.
 */

import { parseHTML } from "linkedom";
import { type DomNode, text } from "./parse/dom.ts";

/**
 * Block-level elements that carry content rather than controls.
 *
 * `li`, `td`, `th`, `dt`, `dd`, `figcaption`, `caption` and `blockquote` join
 * the headings and paragraphs. `option`, `label`, `button` and `legend` stay
 * out: they are the text of a control, not of the page.
 */
const CONTENT =
  "h1, h2, h3, h4, p, li, td, th, dt, dd, figcaption, caption, blockquote";

/** Does this node sit inside a control, whose text belongs to the action layer? */
const insideControl = (el: DomNode): boolean =>
  el.closest?.("form, button, select, label") != null;

export function describe(html: string): string {
  const { document } = parseHTML(html);
  const doc = document as unknown as DomNode;
  const scope = doc.querySelector("main") ?? doc.querySelector("body") ?? doc;

  const parts: string[] = [];
  for (const el of scope.querySelectorAll(CONTENT)) {
    if (insideControl(el)) continue;
    const t = text(el);
    if (t) parts.push(t);
  }
  // de-dupe consecutive repeats (e.g. a heading echoed inside a control)
  return parts.filter((p, i) => p !== parts[i - 1]).join("\n");
}
