/**
 * native.ts — parser for the standardized HTML core: <a href> and <form>.
 *
 * These need no extension to self-describe an action: an anchor is a GET
 * navigation; a form declares its method, action, and the inputs it submits. A
 * form is a native affordance only if it has a real submit control — an
 * action-less form whose only button is an htmx `type=button` is left to the htmx
 * parser, so no phantom native affordance is produced.
 */

import type { Affordance, Method } from "../affordance.ts";
import { collectFields, type DomNode, type Queryable, text } from "./dom.ts";

const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
const asMethod = (m: string): Method => {
  const up = m.toUpperCase();
  return (METHODS.has(up) ? up : "GET") as Method;
};

/** The form's submit control: input[type=submit] or a <button> defaulting to submit. */
function findSubmit(form: DomNode): DomNode | null {
  for (const el of form.querySelectorAll("button, input")) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? (tag === "button" ? "submit" : "")).toLowerCase();
    if (type === "submit") return el;
  }
  return null;
}

export function parseNative(root: Queryable): Affordance[] {
  const out: Affordance[] = [];

  for (const form of root.querySelectorAll("form")) {
    const submit = findSubmit(form);
    if (!submit) continue; // htmx-only / action-less form → not a native affordance
    out.push({
      method: asMethod(form.getAttribute("method") ?? "GET"),
      url: form.getAttribute("action") ?? "",
      fields: collectFields(form),
      label: text(submit) || text(form.querySelector("h1, h2, h3")) || "Submit",
      source: "native",
    });
  }

  for (const a of root.querySelectorAll("a[href]")) {
    out.push({
      method: "GET",
      url: a.getAttribute("href") ?? "",
      fields: [],
      label: text(a),
      source: "native",
    });
  }

  return out;
}
