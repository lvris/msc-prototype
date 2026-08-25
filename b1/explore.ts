/**
 * explore.ts — walk the whole site through its own controls.
 *
 * The walk is the shared substrate of two things: the invariant checker asserts
 * its claims over every state and edge found here, and the task-set generator
 * derives its tasks from the resulting graph rather than from anyone's judgement
 * about which tasks would be interesting.
 *
 * Two rules keep the walk honest:
 *
 *  - it may only act through controls parsed out of the returned HTML, exactly as
 *    an agent perceiving the site would, and
 *  - it restores the session before every edge, so the graph is a real transition
 *    relation and not one arbitrary trajectory through it.
 *
 * Controls are discovered by NATIVE semantics — <a>/<form> and htmx hx-* — with no
 * custom annotation. B1 must stand alone, so this mirrors what agent A does rather
 * than importing it.
 */

import { parseHTML } from "linkedom";
import { SAMPLE_VALUES } from "./catalogue.ts";
import {
  type Affordance,
  CONTENDED_SLOT,
  DATES,
  freshSession,
  LARGE_PARTY,
  needsDeposit,
  type Session,
} from "./model.ts";

export const BASE = `http://localhost:${process.env.PORT ?? 3999}`;

/** Boot the site in-process and wait until it answers. */
export async function startSite(): Promise<void> {
  process.env.PORT = process.env.PORT ?? "3999";
  await import("./server.ts");
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

// ── HTTP + harness access ────────────────────────────────────────────────────

export interface Res {
  status: number;
  html: string;
}

/** Issue exactly the request a control declares: GET in the query, others in the body. */
export async function exec(
  method: string,
  url: string,
  values: Record<string, string>,
): Promise<Res> {
  const target = new URL(url, BASE);
  let r: Response;
  if (method === "GET") {
    for (const [k, v] of Object.entries(values)) target.searchParams.set(k, v);
    r = await fetch(target, { redirect: "follow" });
  } else {
    r = await fetch(target, {
      method,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values).toString(),
      redirect: "follow",
    });
  }
  return { status: r.status, html: await r.text() };
}

/** Pin the site to a given session (harness endpoint, never rendered). */
export async function setSession(s: Session): Promise<void> {
  await fetch(`${BASE}/__session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(s),
  });
}

export async function getSession(): Promise<Session> {
  const r = await fetch(`${BASE}/__session`);
  return ((await r.json()) as { session: Session }).session;
}

export const pageHtml = (): Promise<string> => fetch(`${BASE}/`).then((r) => r.text());

// ── perception ───────────────────────────────────────────────────────────────

export interface Control {
  method: string;
  url: string;
  fields: { name: string; value?: string }[];
  label: string;
}

const HX_VERBS = ["get", "post", "put", "delete"] as const;
const NON_DATA = new Set(["submit", "button", "image", "reset"]);

/* eslint-disable @typescript-eslint/no-explicit-any -- linkedom nodes, structurally used */
function fieldsOf(scope: any): { name: string; value?: string }[] {
  const out: { name: string; value?: string }[] = [];
  for (const el of scope.querySelectorAll("input, select, textarea")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const opts = [...el.querySelectorAll("option")];
      const sel = opts.find((o: any) => o.hasAttribute("selected")) ?? opts[0];
      out.push({ name, value: sel ? (sel.getAttribute("value") ?? undefined) : undefined });
    } else if (tag === "textarea") {
      out.push({ name, value: (el.textContent ?? "").trim() || undefined });
    } else {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (NON_DATA.has(type)) continue;
      out.push({ name, value: el.getAttribute("value") ?? undefined });
    }
  }
  return out;
}

/** Every control an HTML representation offers, by native/htmx semantics alone. */
export function extract(html: string): Control[] {
  const { document } = parseHTML(html);
  const out: Control[] = [];

  // htmx controls: any element carrying an hx-<verb> attribute. If it declares
  // hx-include, the enclosing form's inputs are part of the request.
  for (const el of document.querySelectorAll("[hx-get],[hx-post],[hx-put],[hx-delete]")) {
    for (const verb of HX_VERBS) {
      const url = el.getAttribute(`hx-${verb}`);
      if (!url) continue;
      const form = el.getAttribute("hx-include") ? el.closest("form") : null;
      out.push({
        method: verb.toUpperCase(),
        url,
        fields: form ? fieldsOf(form) : [],
        label: (el.textContent ?? "").trim(),
      });
      break;
    }
  }

  // native forms — only those with a real submit control (an action-less form
  // whose only button is an htmx type=button belongs to the htmx parser).
  for (const form of document.querySelectorAll("form")) {
    const submit = form.querySelector('button[type="submit"], input[type="submit"]');
    if (!submit) continue;
    out.push({
      method: (form.getAttribute("method") ?? "GET").toUpperCase(),
      url: form.getAttribute("action") ?? "",
      fields: fieldsOf(form),
      label: (submit.textContent ?? "").trim(),
    });
  }

  // native links.
  for (const a of document.querySelectorAll("a[href]")) {
    out.push({
      method: "GET",
      url: a.getAttribute("href") ?? "",
      fields: [],
      label: (a.textContent ?? "").trim(),
    });
  }

  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The identity used to compare a rendered control with a model affordance:
 * method, url and every field's name=value. Values matter — two forms posting to
 * /hold with different hidden slots are different affordances, not one.
 */
export const keyOf = (
  method: string,
  url: string,
  fields: { name: string; value?: string }[],
): string => `${method} ${url} [${fields.map((f) => `${f.name}=${f.value ?? ""}`).sort().join(",")}]`;

export const controlKey = (c: Control): string => keyOf(c.method, c.url, c.fields);
export const affordanceKey = (a: Affordance): string => keyOf(a.method, a.url, a.fields ?? []);

// ── state identity ───────────────────────────────────────────────────────────

/**
 * The equivalence class a session belongs to. It keeps every fact any gate reads
 * (party-size band, date, pre-order stage, whether a table was released) and drops
 * what only varies cosmetically (booking reference, guest name, which particular
 * free slot is held, the exact number of dishes), so the walk terminates while
 * still separating every state that has a different action set.
 */
export function stateKey(s: Session): string {
  return [
    s.status,
    `date=${s.date ?? "-"}`,
    needsDeposit(s) ? "large" : "small",
    // which slot is held matters only through whether it is the contended one
    `slot=${s.slot === CONTENDED_SLOT ? "contended" : s.slot ? "held" : "-"}`,
    s.guest ? "guest" : "-",
    `pre=${s.preorder.status}/${s.preorder.dishes.length ? "some" : "none"}`,
    s.waitlistPolled ? "polled" : "-",
    `conflict=${s.conflictSlot ?? "-"}`,
    s.depositPaid ? "paid" : "-",
  ].join("|");
}

/**
 * The full session minus the cosmetic booking reference. `stateKey` is an
 * equivalence class that keeps the walk finite; this is the real thing, and it is
 * what "the action moved the state" must be judged against — adding a second dish
 * is a genuine transition even though it stays in the same class.
 */
export function fullKey(s: Session): string {
  const { bookingId: _drop, ...rest } = s;
  return JSON.stringify(rest);
}

// ── submitted values ─────────────────────────────────────────────────────────

/** Values to submit for a control: HTML defaults first, then a sample per name. */
export function valuesFor(fields: { name: string; value?: string }[]): Record<string, string> {
  const v: Record<string, string> = {};
  for (const f of fields) {
    if (f.value !== undefined) v[f.name] = f.value;
    else if (SAMPLE_VALUES[f.name] !== undefined) v[f.name] = SAMPLE_VALUES[f.name];
    else v[f.name] = "x"; // a field nothing knows about — I5 will catch it
  }
  return v;
}

/**
 * Fields the walk deliberately varies, to drive it down both sides of a gate.
 * Only two, and both are ordinary user input rather than privileged knowledge:
 * which date, and how large a party.
 */
export function variants(fields: { name: string; value?: string }[]): Record<string, string>[] {
  const base = valuesFor(fields);
  const names = fields.map((f) => f.name);
  let combos: Record<string, string>[] = [base];
  if (names.includes("date")) combos = DATES.flatMap((d) => combos.map((c) => ({ ...c, date: d.id })));
  if (names.includes("partySize")) {
    combos = ["2", String(LARGE_PARTY + 2)].flatMap((p) => combos.map((c) => ({ ...c, partySize: p })));
  }
  return combos;
}

// ── the walk ─────────────────────────────────────────────────────────────────

export interface Node {
  key: string;
  session: Session;
  /** shortest witness path from a fresh session, as `METHOD /url` steps. */
  path: string[];
}

export interface Edge {
  from: string;
  to: string;
  control: Control;
  values: Record<string, string>;
  status: number;
  fromSession: Session;
  toSession: Session;
  /** did the full session actually change? */
  moved: boolean;
}

export interface Graph {
  nodes: Map<string, Node>;
  edges: Edge[];
  /** true if the walk closed on its own rather than hitting the cap. */
  complete: boolean;
}

/** Breadth-first walk from a fresh session, acting only through discovered controls. */
export async function explore(maxStates = 5000): Promise<Graph> {
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];

  const start: Node = { key: stateKey(freshSession()), session: freshSession(), path: [] };
  nodes.set(start.key, start);
  const queue: Node[] = [start];

  while (queue.length > 0 && nodes.size < maxStates) {
    const node = queue.shift()!;
    await setSession(node.session);
    const rendered = extract(await pageHtml());

    for (const control of rendered) {
      for (const values of variants(control.fields)) {
        await setSession(node.session);
        const res = await exec(control.method, control.url, values);
        const after = res.status < 400 ? await getSession() : node.session;
        const key = stateKey(after);
        edges.push({
          from: node.key,
          to: key,
          control,
          values,
          status: res.status,
          fromSession: node.session,
          toSession: after,
          moved: fullKey(after) !== fullKey(node.session),
        });
        if (res.status < 400 && !nodes.has(key)) {
          const next: Node = {
            key,
            session: after,
            path: [...node.path, `${control.method} ${control.url}`],
          };
          nodes.set(key, next);
          queue.push(next);
        }
      }
    }
  }

  return { nodes, edges, complete: nodes.size < maxStates };
}

/** Which states can be reached from `from`, following only successful edges. */
export function reachableFrom(graph: Graph, from: string): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.status >= 400) continue;
    (adjacency.get(e.from) ?? adjacency.set(e.from, []).get(e.from)!).push(e.to);
  }
  const out = new Set<string>([from]);
  const stack = [from];
  while (stack.length) {
    for (const next of adjacency.get(stack.pop()!) ?? []) {
      if (out.has(next)) continue;
      out.add(next);
      stack.push(next);
    }
  }
  return out;
}
