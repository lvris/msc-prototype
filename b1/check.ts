/**
 * check.ts — minimal HTTP self-check.
 *
 * Boots the server, drives the three demo flows over `fetch`, and prints the
 * affordances each returned representation exposes. It ASSERTS the two thesis
 * properties:
 *   - a `confirmed` representation exposes no slot-change / edit control (locked);
 *   - a `conflict` representation exposes no confirm control (refusal).
 *
 * The tiny `extract()` below reads controls straight out of the returned HTML
 * (native <form>/<a> + htmx hx-* buttons, keyed by `data-affordance`). It is the
 * dumb seed of the future agent-A parsers — same normalized shape {id,method,url}.
 */

export {}; // make this a module so top-level await is allowed

process.env.PORT = process.env.PORT ?? "3999";
const BASE = `http://localhost:${process.env.PORT}`;

await import("./server.ts"); // starts app.listen on PORT

interface Control {
  id: string;
  method: string;
  url: string;
}

/** Pull every control (element carrying data-affordance) out of an HTML string. */
function extract(html: string): Control[] {
  const tags = html.match(/<[^>]*\bdata-affordance="[^"]*"[^>]*>/g) ?? [];
  const out: Control[] = [];
  for (const tag of tags) {
    const id = /data-affordance="([^"]+)"/.exec(tag)?.[1] ?? "?";
    const hx = /\bhx-(get|post|put|delete|patch)="([^"]+)"/.exec(tag);
    if (hx) {
      out.push({ id, method: hx[1].toUpperCase(), url: hx[2] });
    } else if (/^<form\b/.test(tag)) {
      const method = (/\bmethod="([^"]+)"/.exec(tag)?.[1] ?? "GET").toUpperCase();
      const url = /\baction="([^"]+)"/.exec(tag)?.[1] ?? "";
      out.push({ id, method, url });
    } else if (/^<a\b/.test(tag)) {
      out.push({ id, method: "GET", url: /\bhref="([^"]+)"/.exec(tag)?.[1] ?? "" });
    }
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
  const ids = controls.map((c) => `[${c.id}] ${c.method} ${c.url}`);
  console.log(`  ${label}: ${ids.length ? ids.join("  ") : "(no controls)"}`);
  return controls;
}
const hasId = (cs: Control[], id: string) => cs.some((c) => c.id === id);

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
assert(hasId(confirmed, "cancel_booking"), "confirmed exposes cancel_booking");
assert(!hasId(confirmed, "hold_slot"), "confirmed is LOCKED: no slot-change control");
assert(!hasId(confirmed, "edit_details"), "confirmed is LOCKED: no edit control");

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
assert(!hasId(conflict, "confirm_booking"), "conflict has NO confirm control ('confirm anyway' is unrepresentable)");
assert(hasId(conflict, "hold_slot"), "conflict offers pick-another-slot controls");
await post("/hold", { slot: "19:00" }); // pick a free slot → back to review
await post("/confirm", {});
const resolved = show("confirmed (resolved)", await get("/"));
assert(hasId(resolved, "cancel_booking"), "conflict resolved into a confirmed booking");

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
