/**
 * present.ts — draw the rendered controls as HTML.
 *
 * `render.ts` decides WHAT the interface contains; this decides how it looks.
 * The split matters: the thesis claims something about the first and nothing
 * about the second. Everything here is presentation — markup, wording, layout —
 * and could be replaced wholesale (by a component library, by an event protocol
 * such as AG-UI, by a native toolkit) without touching a single claim, because
 * the set being drawn was already closed before this file saw it.
 *
 * The three layers the design chapter separates are all visible in the output:
 *
 *   the ACTION layer        one <form> per control, bounded by A(s).
 *   the ELICITATION layer   the inputs inside it. Which questions appear is
 *                           decided by the control's declared fields, and the
 *                           permitted values it enumerates are the answers the
 *                           interface will accept.
 *   the PRESENTATION layer  the `note` — prose about what is on offer and what
 *                           is structurally absent. This is the agent's own
 *                           language and nothing here bounds it.
 *
 * Each field is marked with where its value comes from, so a screenshot of this
 * output carries the same distinction the elicitation figures are counted from:
 * a value the control fixes, a default the user may change, and a question the
 * interface has to ask.
 *
 * `dead` is supplied by the CALLER. Whether a control is executable in the
 * current state is a fact about the application, and A holds no such facts — it
 * would have to be told, which is exactly what the experiment harness does when
 * it draws a catalogue-backed surface next to a hypermedia-backed one.
 */

import type { RenderedControl, Widget } from "./render.ts";

export interface PresentOptions {
  /** heading for the surface. */
  title?: string;
  /** prose above the controls: the presentation layer, narrated rather than derived. */
  note?: string;
  /** make relative targets absolute, so the emitted page can drive the site for real. */
  base?: string;
  /**
   * Controls (by `key`) that cannot be executed in the state being drawn. A
   * hypermedia-backed surface has none by construction; a catalogue-backed one
   * is where this is worth showing.
   */
  dead?: ReadonlySet<string>;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const attr = (name: string, value?: string): string =>
  value === undefined ? "" : ` ${name}="${esc(value)}"`;

/** One widget becomes one native control. The kind decides which; nothing else does. */
function widgetHtml(w: Widget): string {
  const req = w.required ? " required" : "";
  const id = `f-${w.field}`;
  let input: string;

  if (w.kind === "select") {
    const opts = (w.options ?? [])
      .map((o) => `<option${attr("value", o)}${o === w.prefill ? " selected" : ""}>${esc(o)}</option>`)
      .join("");
    input = `<select id="${esc(id)}"${attr("name", w.field)}${req}>${opts}</select>`;
  } else if (w.kind === "textarea") {
    input = `<textarea id="${esc(id)}"${attr("name", w.field)}${req}>${esc(w.prefill ?? "")}</textarea>`;
  } else if (w.kind === "checkbox") {
    input = `<input type="checkbox" id="${esc(id)}"${attr("name", w.field)}${req}>`;
  } else {
    input = `<input type="${esc(w.kind)}" id="${esc(id)}"${attr("name", w.field)}${attr("value", w.prefill)}${req}>`;
  }

  const badge =
    w.demand === "asked"
      ? `<span class="tag ask">must ask</span>`
      : w.demand === "prefilled"
        ? `<span class="tag pre">prefilled</span>`
        : `<span class="tag opt">optional</span>`;
  const degraded = w.degraded ? `<span class="tag warn">unknown type</span>` : "";

  return `<p class="field ${w.demand}"><label for="${esc(id)}">${esc(w.label)}</label>${badge}${degraded}${input}</p>`;
}

/** One control becomes one form. Never zero, never two. */
function controlHtml(c: RenderedControl, o: PresentOptions): string {
  const dead = o.dead?.has(c.key) === true;
  const action = o.base ? new URL(c.url || "/", o.base).toString() : c.url;

  // A form can only carry GET or POST; other verbs travel as a hidden override,
  // the same convention a browser-facing app uses. The affordance is unchanged.
  const formMethod = c.method === "GET" ? "get" : "post";
  const override =
    c.method === "GET" || c.method === "POST"
      ? ""
      : `<input type="hidden" name="_method"${attr("value", c.method)}>`;

  const fixed = Object.entries(c.fixed);
  const fixedInputs = fixed
    .map(([k, v]) => `<input type="hidden"${attr("name", k)}${attr("value", v)}>`)
    .join("");
  const fixedNote = fixed.length
    ? `<p class="fixed"><span class="tag fix">fixed by the control</span>` +
      fixed.map(([k, v]) => `<code>${esc(k)}=${esc(v)}</code>`).join(" ") +
      `</p>`
    : "";

  return [
    `<form class="control${dead ? " dead" : ""}" method="${formMethod}"${attr("action", action)}>`,
    `<header><span class="verb">${esc(c.method)}</span> <code>${esc(c.url)}</code>`,
    dead ? `<span class="tag bad">not valid in this state</span>` : "",
    `</header>`,
    override,
    fixedInputs,
    fixedNote,
    ...c.widgets.map(widgetHtml),
    `<button type="submit">${esc(c.label)}</button>`,
    `</form>`,
  ].join("");
}

const STYLE = `
:root { color-scheme: light; }
body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 1.5rem; background: #fafafa; color: #222; }
h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
.note { margin: 0 0 1.25rem; color: #555; max-width: 46rem; }
.controls { display: flex; flex-wrap: wrap; gap: .75rem; align-items: flex-start; }
.control { border: 1px solid #d4d4d4; border-radius: 6px; background: #fff; padding: .7rem .8rem; min-width: 15rem; max-width: 21rem; }
.control header { font-size: .75rem; color: #666; margin-bottom: .5rem; display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; }
.control.dead { opacity: .55; border-style: dashed; background: #f6f6f6; }
.verb { font-weight: 700; letter-spacing: .04em; }
code { font: .75rem ui-monospace, monospace; background: #f0f0f0; padding: .05rem .25rem; border-radius: 3px; }
.field { margin: .45rem 0; display: flex; flex-direction: column; gap: .2rem; }
.field label { font-size: .8rem; font-weight: 600; }
input, select, textarea { font: inherit; padding: .3rem .4rem; border: 1px solid #c4c4c4; border-radius: 4px; width: 100%; box-sizing: border-box; }
textarea { min-height: 3.5rem; }
button { margin-top: .55rem; font: inherit; padding: .35rem .8rem; border: 1px solid #444; border-radius: 4px; background: #333; color: #fff; cursor: pointer; }
.control.dead button { background: #999; border-color: #999; cursor: not-allowed; }
.fixed { margin: .3rem 0; font-size: .75rem; color: #555; display: flex; gap: .3rem; align-items: center; flex-wrap: wrap; }
.tag { font-size: .62rem; text-transform: uppercase; letter-spacing: .05em; padding: .05rem .3rem; border-radius: 3px; align-self: flex-start; }
.tag.ask  { background: #fde8c8; color: #7a4a06; }
.tag.pre  { background: #e2ecfa; color: #204070; }
.tag.opt  { background: #eee; color: #666; }
.tag.fix  { background: #e4f2e4; color: #245024; }
.tag.warn { background: #fbe0e0; color: #7a1414; }
.tag.bad  { background: #7a1414; color: #fff; }
.empty { color: #777; font-style: italic; }
`;

/** The controls as a fragment, for embedding next to another surface. */
export function toFragment(controls: RenderedControl[], o: PresentOptions = {}): string {
  const head = [
    o.title ? `<h1>${esc(o.title)}</h1>` : "",
    o.note ? `<p class="note">${esc(o.note)}</p>` : "",
  ].join("");
  const body = controls.length
    ? `<div class="controls">${controls.map((c) => controlHtml(c, o)).join("")}</div>`
    : `<p class="empty">No actions are available in this state.</p>`;
  return head + body;
}

/** A standalone, self-contained page — no external stylesheet, no script. */
export function toHtml(controls: RenderedControl[], o: PresentOptions = {}): string {
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8">`,
    `<title>${esc(o.title ?? "Generated surface")}</title>`,
    `<style>${STYLE}</style></head><body>`,
    toFragment(controls, o),
    `</body></html>`,
  ].join("");
}

export { STYLE as presentationStyle };
