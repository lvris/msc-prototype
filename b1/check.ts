/**
 * check.ts — minimal HTTP self-check.
 *
 * Boots the server, drives the three demo flows over `fetch`, and prints the
 * controls each returned representation exposes. It ASSERTS the two thesis
 * properties:
 *   - a `confirmed` representation exposes no slot-change / edit control (locked);
 *   - a `conflict` representation exposes no confirm control (refusal).
 *
 * `extract()` discovers controls straight from the returned HTML by their NATIVE
 * semantics — native <a>/<form> and htmx hx-* elements — with NO reliance on any
 * custom annotation. It keys each control by `{method, url}`, exactly the way the
 * future agent A perceives a site. B1 must stand alone, so this does not import
 * from `a/`; it just mirrors the same idea.
 */

import { parseHTML } from "linkedom";

export {}; // make this a module so top-level await is allowed

process.env.PORT = process.env.PORT ?? "3999";
const BASE = `http://localhost:${process.env.PORT}`;

await import("./server.ts"); // starts app.listen on PORT

interface Control {
  method: string;
  url: string;
  label: string;
}

/** Pull every control out of an HTML string by native/htmx semantics. */
function extract(html: string): Control[] {
  const { document } = parseHTML(html);
  const out: Control[] = [];

  // htmx controls: any element carrying an hx-<verb> attribute.
  for (const el of document.querySelectorAll("[hx-get],[hx-post],[hx-put],[hx-delete]")) {
    for (const verb of ["get", "post", "put", "delete"]) {
      const url = el.getAttribute(`hx-${verb}`);
      if (url) {
        out.push({ method: verb.toUpperCase(), url, label: (el.textContent ?? "").trim() });
        break;
      }
    }
  }

  // native forms — only those with a real submit control (an action-less form
  // whose only button is an htmx type=button is the htmx parser's job, skipped).
  for (const form of document.querySelectorAll("form")) {
    const submit = form.querySelector('button[type="submit"], input[type="submit"]');
    if (!submit) continue;
    const method = (form.getAttribute("method") ?? "GET").toUpperCase();
    const url = form.getAttribute("action") ?? "";
    out.push({ method, url, label: (submit.textContent ?? "").trim() });
  }

  // native links.
  for (const a of document.querySelectorAll("a[href]")) {
    out.push({ method: "GET", url: a.getAttribute("href") ?? "", label: (a.textContent ?? "").trim() });
  }

  return out;
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

const form = (obj: Record<string, string>) => new URLSearchParams(obj).toString();

async function get(path: string, htmx = false): Promise<string> {
  const r = await fetch(`${BASE}${path}`, { headers: htmx ? { "HX-Request": "true" } : {} });
  return r.text();
}
async function post(path: string, body: Record<string, string>, htmx = false): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(htmx ? { "HX-Request": "true" } : {}),
    },
    body: form(body),
  });
}

const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failures.push(msg);
  }
}

function show(label: string, html: string): Control[] {
  const controls = extract(html);
  const ids = controls.map((c) => `${c.method} ${c.url} (${c.label})`);
  console.log(`  ${label}: ${ids.length ? ids.join("  ") : "(no controls)"}`);
  return controls;
}
const has = (cs: Control[], method: string, url: string) =>
  cs.some((c) => c.method === method && c.url === url);

await waitForServer();

// ── Scenario 1: happy path ────────────────────────────────────────────────
console.log("\n# Scenario 1 — happy path");
show("browsing", await get("/reset"));
show("availability (htmx fragment)", await get("/availability?date=2026-07-10&partySize=2", true));
await post("/hold", { slot: "19:00" }); // native POST → PRG
show("holding", await get("/"));
await post("/details", { name: "Ada Lovelace", phone: "+358 40 123 4567" });
show("details_entered", await get("/"));
await post("/confirm", {});
const confirmed = show("confirmed", await get("/"));
assert(has(confirmed, "DELETE", "/booking"), "confirmed exposes cancel (DELETE /booking)");
assert(!has(confirmed, "POST", "/hold"), "confirmed is LOCKED: no slot-change control (POST /hold)");
assert(!has(confirmed, "POST", "/edit-details"), "confirmed is LOCKED: no edit control (POST /edit-details)");

// ── Scenario 2: locked — a crafted request is refused, not just hidden ──────
console.log("\n# Scenario 2 — locked action refused by the guard");
const refused = await post("/hold", { slot: "18:00" }); // try to change a confirmed booking
assert(refused.status === 409, `POST /hold on a confirmed booking is refused (got ${refused.status})`);

// ── Scenario 3: conflict — no "confirm anyway", resolve via another slot ────
console.log("\n# Scenario 3 — conflict refusal + resolution");
await get("/reset");
await get("/availability?date=2026-07-10&partySize=2", true);
await post("/hold", { slot: "20:00" }); // the contended slot
await post("/details", { name: "Ada Lovelace", phone: "+358 40 123 4567" });
await post("/confirm", {}); // conflicts
const conflict = show("conflict", await get("/"));
assert(!has(conflict, "POST", "/confirm"), "conflict has NO confirm control ('confirm anyway' is unrepresentable)");
assert(has(conflict, "POST", "/hold"), "conflict offers pick-another-slot controls (POST /hold)");
await post("/hold", { slot: "19:00" }); // pick a free slot → back to review
await post("/confirm", {});
const resolved = show("confirmed (resolved)", await get("/"));
assert(has(resolved, "DELETE", "/booking"), "conflict resolved into a confirmed booking");

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
