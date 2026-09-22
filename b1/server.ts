/**
 * server.ts — transport layer.
 *
 * Wires HTTP requests to model transitions and renders the result. Three things
 * worth noting for the thesis:
 *
 *  1. Every route first calls `isAffordanceValid` — invalid actions are refused
 *     (409), not just hidden. Representation + guard together make the action
 *     space closed.
 *  2. Dual response: htmx sends an `HX-Request` header, so the same endpoint
 *     returns a *fragment* to htmx and does Post/Redirect/Get (full page) for a
 *     plain browser form. Same affordance, two consumers, one set of controls.
 *  3. No route re-decides whether an action is allowed. The gates G1–G5 live in
 *     `model.ts` alone; a handler only performs the transition it is named for.
 */

import express from "express";
import {
  ALL_ACTION_IDS,
  canonicalise,
  CONTENDED_SLOT,
  freeSlots,
  freshSession,
  isAffordanceValid,
  MENU,
  needsDeposit,
  type Session,
  validAffordances,
} from "./model.ts";
import { cancellationPage, confirmationPage, page, panel, slotsFragment } from "./render.ts";

// Single in-memory session (single-user demo; no login/DB by design).
let session: Session = freshSession();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json()); // only the /__session harness endpoint uses this

const isHtmx = (req: express.Request): boolean => req.get("HX-Request") === "true";

/** Refuse an action that is not currently valid. */
function guard(_req: express.Request, res: express.Response, id: string): boolean {
  if (isAffordanceValid(session, id)) return true;
  res
    .status(409)
    .type("html")
    .send(`<p>Action <code>${id}</code> is not available in state <code>${session.status}</code>.</p>`);
  return false;
}

/** After a native (non-htmx) mutation: Post/Redirect/Get. htmx: swap the panel. */
function respond(req: express.Request, res: express.Response): void {
  if (isHtmx(req)) res.type("html").send(panel(session));
  else res.redirect(303, "/");
}

app.get("/", (_req, res) => {
  res.type("html").send(page(session));
});

// ── browsing ─────────────────────────────────────────────────────────────────

// check availability (htmx: refresh only #slots)
app.get("/availability", (req, res) => {
  if (!guard(req, res, "check_availability")) return;
  session.date = String(req.query.date ?? "");
  session.partySize = Number(req.query.partySize ?? 2) || 2;
  if (isHtmx(req)) res.type("html").send(slotsFragment(session));
  else res.redirect(303, "/");
});

// browsing / conflict / waitlisted (after a release) → hold a slot
app.post("/hold", (req, res) => {
  if (!guard(req, res, "hold_slot")) return;
  // Same tolerance as the menu: a 409 must mean the slot is taken, not that the
  // time arrived with a stray space around it.
  const slot = canonicalise(String(req.body.slot ?? ""), freeSlots(session));
  if (slot === undefined) {
    res.status(409).type("html").send(`<p>Slot ${String(req.body.slot ?? "")} is not available.</p>`);
    return;
  }
  session.slot = slot;
  session.waitlistPosition = undefined;
  // If we already have the guest (came back here from a conflict), jump straight
  // to the review stage the party size dictates; otherwise ask for details first.
  session.status = session.guest ? reviewStatus() : "holding";
  respond(req, res);
});

// ── waitlist (G4) ────────────────────────────────────────────────────────────

app.post("/waitlist", (req, res) => {
  if (!guard(req, res, "join_waitlist")) return;
  session.status = "waitlisted";
  session.waitlistPosition = 3;
  respond(req, res);
});

// checking the queue is what reveals that a table has been released (G4): the
// set of valid actions GROWS as a result of a read.
app.get("/waitlist", (req, res) => {
  if (!guard(req, res, "check_position")) return;
  session.waitlistPolled = true;
  session.waitlistPosition = 1;
  res.type("html").send(page(session));
});

app.delete("/waitlist", (req, res) => {
  if (!guard(req, res, "leave_waitlist")) return;
  session.waitlistPosition = undefined;
  session.status = "browsing";
  respond(req, res);
});

// ── holding ──────────────────────────────────────────────────────────────────

// G1: the review stage a party size lands in. This is the whole of the deposit
// gate — a large party never passes through `details_entered`.
const reviewStatus = (): Session["status"] =>
  needsDeposit(session) ? "deposit_pending" : "details_entered";

app.post("/details", (req, res) => {
  if (!guard(req, res, "enter_details")) return;
  session.guest = { name: String(req.body.name ?? ""), phone: String(req.body.phone ?? "") };
  session.status = reviewStatus();
  respond(req, res);
});

// back to browsing, keep date/party, drop the slot
app.post("/change-slot", (req, res) => {
  if (!guard(req, res, "change_slot")) return;
  session.slot = undefined;
  session.status = "browsing";
  respond(req, res);
});

app.delete("/hold", (req, res) => {
  if (!guard(req, res, "release_hold")) return;
  session.slot = undefined;
  session.status = "browsing";
  respond(req, res);
});

// ── draft stage: details_entered / deposit_pending ───────────────────────────

app.post("/edit-details", (req, res) => {
  if (!guard(req, res, "edit_details")) return;
  session.status = "holding";
  respond(req, res);
});

// G5: discarding a draft is NOT cancelling a booking — different URL, no reason,
// and it leaves the guest free to start again from the slot list.
app.delete("/draft", (req, res) => {
  if (!guard(req, res, "discard_draft")) return;
  session.guest = undefined;
  session.slot = undefined;
  session.preorder = { status: "none", dishes: [] };
  session.status = "browsing";
  respond(req, res);
});

/** Finish a booking, unless the contended slot has been taken meanwhile. */
function settle(req: express.Request, res: express.Response): void {
  if (session.slot === CONTENDED_SLOT && session.conflictSlot === undefined) {
    session.conflictSlot = session.slot;
    session.status = "conflict";
  } else {
    session.status = "confirmed";
    session.bookingId = "R" + String(Math.abs(hash(JSON.stringify(session))) % 100000).padStart(5, "0");
  }
  respond(req, res);
}

/** Deterministic booking reference — no randomness, so runs stay reproducible. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

app.post("/confirm", (req, res) => {
  if (!guard(req, res, "confirm_booking")) return;
  settle(req, res);
});

// G1: the large-party path to the very same outcome
app.post("/deposit", (req, res) => {
  if (!guard(req, res, "pay_deposit")) return;
  if (!String(req.body.card ?? "").trim()) {
    res.status(400).type("html").send(`<p>A card number is required.</p>`);
    return;
  }
  session.depositPaid = true;
  settle(req, res);
});

// ── pre-order sub-resource (G3) ──────────────────────────────────────────────

app.post("/preorder", (req, res) => {
  if (!guard(req, res, "open_preorder")) return;
  session.preorder = { status: "open", dishes: [] };
  respond(req, res);
});

app.post("/preorder/dishes", (req, res) => {
  if (!guard(req, res, "add_dish")) return;
  // Matched tolerantly and stored in the kitchen's own spelling: a 400 here has
  // to mean "we do not serve that", not "you capitalised it differently".
  const dish = canonicalise(String(req.body.dish ?? ""), MENU);
  if (dish === undefined) {
    res.status(400).type("html").send(`<p>No such dish: ${String(req.body.dish ?? "")}</p>`);
    return;
  }
  session.preorder.dishes.push(dish);
  respond(req, res);
});

app.delete("/preorder/dishes", (req, res) => {
  if (!guard(req, res, "remove_dish")) return;
  // htmx may put a DELETE's parameters in the query string rather than the body
  const index = Number(req.body.index ?? req.query.index);
  if (Number.isInteger(index) && index >= 0 && index < session.preorder.dishes.length) {
    session.preorder.dishes.splice(index, 1);
  }
  respond(req, res);
});

app.post("/preorder/submit", (req, res) => {
  if (!guard(req, res, "submit_preorder")) return;
  session.preorder.status = "submitted";
  respond(req, res);
});

// ── confirmed ────────────────────────────────────────────────────────────────

app.get("/confirmation", (req, res) => {
  if (!guard(req, res, "view_confirmation")) return;
  res.type("html").send(confirmationPage(session));
});

// G2: outside the cancellation window — cancel outright
app.delete("/booking", (req, res) => {
  if (!guard(req, res, "cancel_booking")) return;
  session.status = "cancelled";
  respond(req, res);
});

// G2: inside the window — the same intent becomes a request that needs a reason
app.post("/cancellation-request", (req, res) => {
  if (!guard(req, res, "request_cancellation")) return;
  const reason = String(req.body.reason ?? "").trim();
  if (!reason) {
    res.status(400).type("html").send(`<p>A reason is required within 24h of seating.</p>`);
    return;
  }
  session.cancellationReason = reason;
  session.status = "cancellation_requested";
  respond(req, res);
});

app.get("/cancellation", (req, res) => {
  if (!guard(req, res, "view_cancellation")) return;
  res.type("html").send(cancellationPage(session));
});

// ── start over ───────────────────────────────────────────────────────────────

app.get("/reset", (req, res) => {
  if (!guard(req, res, "start_over")) return;
  session = freshSession();
  res.redirect(303, "/");
});

// ── harness endpoints ────────────────────────────────────────────────────────
// Not affordances: they are never rendered, never discoverable from HTML, and A
// has no way to reach them. They exist so the invariant checker and the
// experiment collector can pin the session to a known state and read the ground
// truth (`validAffordances`) without going through the UI.

app.post("/__session", (req, res) => {
  session = { ...freshSession(), ...(req.body as Partial<Session>) };
  res.type("html").send(panel(session));
});

app.get("/__session", (_req, res) => {
  res.json({ session, valid: validAffordances(session), all: ALL_ACTION_IDS });
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`B1 restaurant-booking site → http://localhost:${PORT}`);
});
