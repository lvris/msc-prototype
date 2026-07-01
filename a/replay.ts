/**
 * replay.ts — act by HTTP replay, not by driving a browser.
 *
 * Given a discovered affordance and the values to submit, A constructs the exact
 * HTTP request the control describes and sends it with `fetch`. This is what
 * "clicking the control" means without a browser: for an honest hypermedia
 * control the request is a pure function of (method, url, fields, values).
 *
 * A never sends the `HX-Request` header, so B answers on its non-htmx path — a
 * full-page Post/Redirect/Get response. `fetch` follows the 303, so A always ends
 * up reading a complete representation. No fragments, no htmx runtime.
 */

import type { Affordance } from "./affordance.ts";

export interface ReplayResult {
  status: number;
  html: string;
  url: string;
  /** true when the guard refused the request (should not happen from a discovered set). */
  refused: boolean;
}

/** Resolve the control's (possibly relative or empty) url against the current page. */
function resolve(affordanceUrl: string, currentUrl: string): string {
  return new URL(affordanceUrl || currentUrl, currentUrl).toString();
}

/**
 * The values to submit for a control: HTML defaults (prefilled/selected) first,
 * then whatever the chooser/user provided for editable fields, with hidden fields
 * forced back to their declared value (they are fixed by the control, not chosen).
 */
export function prepareValues(a: Affordance, provided: Record<string, string> = {}): Record<string, string> {
  const values: Record<string, string> = {};
  for (const f of a.fields) if (f.value !== undefined) values[f.name] = f.value;
  Object.assign(values, provided);
  for (const f of a.fields) if (f.type === "hidden" && f.value !== undefined) values[f.name] = f.value;
  return values;
}

export async function replay(
  affordance: Affordance,
  values: Record<string, string>,
  currentUrl: string,
): Promise<ReplayResult> {
  const target = resolve(affordance.url, currentUrl);

  let res: Response;
  if (affordance.method === "GET") {
    const u = new URL(target);
    for (const [k, v] of Object.entries(values)) u.searchParams.set(k, v);
    res = await fetch(u, { redirect: "follow" });
  } else {
    res = await fetch(target, {
      method: affordance.method,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values).toString(),
      redirect: "follow",
    });
  }

  return {
    status: res.status,
    html: await res.text(),
    url: res.url || target,
    refused: res.status === 409,
  };
}
