/**
 * render.ts — the second consumer of A(s).
 *
 * `discover.ts` produces the affordance set; `choose.ts` + `replay.ts` consume it
 * by EXECUTING one element. This module consumes the same set by PRESENTING it.
 * Two consumers, one input, and the design chapter's claim is about what they
 * have in common: neither authors elements of its own, so both are confined to
 * what the server put in the representation.
 *
 * The load-bearing property of this file is what it does NOT do:
 *
 *   THERE IS NO MODEL IN THE RENDERING PATH.
 *
 * Turning an affordance into a control is a lookup on the field's declared type
 * — the table below is the whole of it. Nothing is generated, nothing is chosen,
 * nothing is inferred. `check.ts` asserts this mechanically (R1) by reading this
 * file's own source: it may import nothing but `./affordance.ts`. The claim is
 * therefore checkable rather than merely asserted, which is the point of keeping
 * the module this small.
 *
 * The division of labour this implements is stated in the design chapter as:
 * the content is narrated by the agent; the controls are authorised by the
 * server. Only the controls are built here.
 *
 * What a control's fields become:
 *
 *   hidden with a value  ──►  `fixed`     the control decides it; no widget, the
 *                                         user is never shown a question
 *   anything else        ──►  a `Widget`  drawn from its declared type, carrying
 *                                         the declared default and, where the
 *                                         control enumerates them, the permitted
 *                                         values — which are exactly the answers
 *                                         the interface may accept
 */

import { type Affordance, type AffordanceField, affordanceKey, type Method } from "./affordance.ts";

export type WidgetKind =
  | "text"
  | "textarea"
  | "select"
  | "checkbox"
  | "number"
  | "date"
  | "time"
  | "tel"
  | "email"
  | "url"
  | "password";

/**
 * What the interface must do about this field before the control can be used.
 *
 *   prefilled  a value is already there; the control is usable as it stands and
 *              the user may override it.
 *   asked      required, and nothing declares a value — the interface has to put
 *              a question to the user. This is the elicitation layer's whole
 *              input: WHICH questions get asked is decided here, by the control,
 *              not by the agent.
 *   optional   no value and not required; nothing is asked and nothing is sent.
 */
export type Demand = "prefilled" | "asked" | "optional";

export interface Widget {
  field: string;
  kind: WidgetKind;
  label: string;
  required: boolean;
  /** the permitted values the control enumerates, when it does. */
  options?: string[];
  /** the default the representation supplied. */
  prefill?: string;
  demand: Demand;
  /**
   * The declared type had no entry in the table and fell back to a text box. Not
   * an error — an unknown vocabulary must degrade, not crash — but it is a loss,
   * and the design chapter's account of parser loss is written from these.
   */
  degraded?: boolean;
}

export interface RenderedControl {
  /** same identity `discover`/`judge` use, so a control can be traced to its affordance. */
  key: string;
  label: string;
  method: Method;
  url: string;
  /** what the user may set, in the order the control declared them. */
  widgets: Widget[];
  /** what the control fixes on the user's behalf; submitted, never shown. */
  fixed: Record<string, string>;
}

/**
 * Declared type → widget. This table IS the rendering step; there is nothing
 * else. It is deliberately a total function via the fallback below, so a
 * representation using a vocabulary A has never seen still produces a usable
 * interface rather than an exception.
 */
const WIDGET: Readonly<Record<string, WidgetKind>> = {
  // free text
  text: "text",
  search: "text",
  color: "text",
  // constrained text
  tel: "tel",
  email: "email",
  url: "url",
  password: "password",
  // numeric
  number: "number",
  range: "number",
  // temporal
  date: "date",
  month: "date",
  week: "date",
  "datetime-local": "date",
  time: "time",
  // non-input elements
  select: "select",
  textarea: "textarea",
  // boolean
  checkbox: "checkbox",
};

const hasValue = (f: AffordanceField): boolean => f.value !== undefined && f.value !== "";

/** A field the control fixes: hidden and carrying its own value. */
const isFixed = (f: AffordanceField): boolean => f.type === "hidden" && f.value !== undefined;

function toWidget(f: AffordanceField): Widget {
  const kind = WIDGET[f.type.toLowerCase()];
  const required = f.required === true;
  const demand: Demand = hasValue(f) ? "prefilled" : required ? "asked" : "optional";

  const w: Widget = {
    field: f.name,
    kind: kind ?? "text",
    label: f.label ?? f.name,
    required,
    demand,
  };
  if (f.options?.length) w.options = [...f.options];
  if (f.value !== undefined) w.prefill = f.value;
  if (kind === undefined) w.degraded = true;
  return w;
}

/** One affordance becomes one control. Never zero, never two. */
export function renderControl(a: Affordance): RenderedControl {
  const fixed: Record<string, string> = {};
  const widgets: Widget[] = [];
  for (const f of a.fields) {
    if (isFixed(f)) fixed[f.name] = f.value as string;
    else widgets.push(toWidget(f));
  }
  return { key: affordanceKey(a), label: a.label, method: a.method, url: a.url, widgets, fixed };
}

/**
 * The affordance set becomes the control set, one for one and in order.
 *
 * There is no filtering step. The design chapter allows a surface to present a
 * SUBSET of A(s) — an agent may judge some controls irrelevant to the intent —
 * but selecting that subset is a model decision, and admitting one here would put
 * a model back in the rendering path. Relevance filtering, if it is ever added,
 * belongs upstream: it would narrow the array handed to this function, which
 * would go on rendering whatever it is given.
 */
export function render(affordances: Affordance[]): RenderedControl[] {
  return affordances.map(renderControl);
}

/** Field names a control needs from the user before it can be submitted. */
export const asked = (c: RenderedControl): string[] =>
  c.widgets.filter((w) => w.demand === "asked").map((w) => w.field);
