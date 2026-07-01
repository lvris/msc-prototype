/**
 * render.ts — representation layer.
 *
 * Turns model state into HTML. It is "dumb": every interactive control it emits
 * comes from `validAffordances(session)` (plus the dynamic slot list), so the
 * page can never expose an action the model does not currently allow.
 *
 * `renderAffordance()` is the one place that maps a normalized affordance onto
 * concrete markup — native `<a>`/`<form>` for the standardized core, and htmx
 * `hx-*` attributes only at the boundaries native HTML cannot self-describe
 * (verbs beyond GET/POST, partial updates).
 */

import {
  type Affordance,
  type Field,
  type Session,
  slotOptions,
  validAffordances,
} from "./model.ts";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderField(f: Field): string {
  if (f.type === "hidden") {
    return `<input type="hidden" name="${f.name}" value="${esc(f.value ?? "")}">`;
  }
  const attrs = [
    `name="${f.name}"`,
    `type="${f.type}"`,
    f.value !== undefined ? `value="${esc(f.value)}"` : "",
    f.required ? "required" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<label>${esc(f.label ?? f.name)}<input ${attrs}></label>`;
}

/**
 * Map one normalized affordance to markup.
 * - native: an `<a href>` (GET, no fields) or a `<form action method>`.
 * - htmx:   a bare `hx-*` button (verb actions) or a form whose submit button
 *           carries the `hx-*` attributes (GET-with-fields, e.g. availability).
 */
export function renderAffordance(a: Affordance): string {
  if (a.kind === "native") {
    if (a.method === "GET" && !a.fields?.length) {
      return `<a role="button" href="${a.url}">${esc(a.label)}</a>`;
    }
    const fields = (a.fields ?? []).map(renderField).join("\n");
    return `
<form method="${a.method}" action="${a.url}">
${fields}
<button type="submit">${esc(a.label)}</button>
</form>`.trim();
  }

  // htmx
  const hasFields = Boolean(a.fields?.length);
  const hx = [
    `hx-${a.method.toLowerCase()}="${a.url}"`,
    // explicitly include the enclosing form's inputs, so "what gets sent" is
    // self-described in the attribute rather than relying on htmx's implicit rule
    hasFields ? `hx-include="closest form"` : "",
    a.target ? `hx-target="${a.target}"` : "",
    a.swap ? `hx-swap="${a.swap}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (hasFields) {
    // A form carries the inputs; the button issues the htmx request and includes
    // the enclosing form's values. The submitted values therefore live in real
    // named inputs — reconstructible from HTML alone.
    const fields = a.fields!.map(renderField).join("\n");
    return `
<form>
${fields}
<button type="button" ${hx}>${esc(a.label)}</button>
</form>`.trim();
  }

  return `<button type="button" ${hx}>${esc(a.label)}</button>`;
}

/** The dynamic slot list (its own representation; swapped into #slots by htmx). */
export function slotsFragment(session: Session): string {
  const opts = slotOptions(session);
  if (session.status === "browsing" && !session.date) {
    return `<p><small>Pick a date and check availability to see tables.</small></p>`;
  }
  const rows = opts
    .map((o) => {
      if (o.taken) {
        return `<li>${o.slot} — <ins>taken</ins></li>`;
      }
      return `<li>
<form method="post" action="/hold" style="display:inline">
<input type="hidden" name="slot" value="${o.slot}">
<button type="submit">Hold ${o.slot}</button>
</form>
</li>`;
    })
    .join("\n");
  return `<ul>\n${rows}\n</ul>`;
}

function summary(session: Session): string {
  const bits: string[] = [];
  if (session.date) bits.push(`<strong>${esc(session.date)}</strong>`);
  if (session.slot) bits.push(`at <strong>${esc(session.slot)}</strong>`);
  if (session.partySize) bits.push(`for <strong>${session.partySize}</strong>`);
  if (session.guest) bits.push(`— ${esc(session.guest.name)} (${esc(session.guest.phone)})`);
  return bits.length ? `<p>${bits.join(" ")}</p>` : "";
}

/** The inner HTML of the #booking panel for the current state. */
export function panel(session: Session): string {
  const controls = validAffordances(session).map(renderAffordance).join("\n");

  switch (session.status) {
    case "browsing":
      return `
<h2>Find a table</h2>
${controls}
<div id="slots">${slotsFragment(session)}</div>`.trim();

    case "holding":
      return `
<h2>Table held</h2>
${summary(session)}
<p><small>Held for you — enter your details to continue.</small></p>
${controls}`.trim();

    case "details_entered":
      return `
<h2>Review &amp; confirm</h2>
${summary(session)}
${controls}`.trim();

    case "confirmed":
      return `
<h2>Booked! 🎉</h2>
${summary(session)}
<p>Confirmation <strong>#${esc(session.bookingId ?? "")}</strong></p>
${controls}`.trim();

    case "conflict":
      return `
<h2>That slot was just taken</h2>
${summary(session)}
<p><mark>${esc(session.slot ?? "")} is no longer available.</mark> Pick another slot to continue.</p>
${controls}`.trim();

    case "cancelled":
      return `
<h2>Booking cancelled</h2>
${controls}`.trim();
  }
}

/** The full HTML document (returned on GET / and after native POST redirects). */
export function page(session: Session): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>La Trattoria — reservations</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
</head>
<body>
<header class="container">
<nav><ul><li><strong>La Trattoria</strong></li></ul><ul><li><small>reservations</small></li></ul></nav>
</header>
<main class="container">
<article id="booking">
${panel(session)}
</article>
</main>
</body>
</html>`;
}

/** Read-only confirmation representation (GET /confirmation). */
export function confirmationPage(session: Session): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Confirmation</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
</head>
<body>
<main class="container">
<article>
<h2>Reservation confirmed</h2>
${summary(session)}
<p>Confirmation <strong>#${esc(session.bookingId ?? "")}</strong></p>
<a href="/">Back</a>
</article>
</main>
</body>
</html>`;
}
