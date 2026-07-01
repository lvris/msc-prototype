/**
 * server.ts — transport layer.
 *
 * Wires HTTP requests to model transitions and renders the result. Two things
 * worth noting for the thesis:
 *
 *  1. Every mutating route first calls `isAffordanceValid` — invalid actions are
 *     refused (409), not just hidden. Representation + guard together make the
 *     action space closed.
 *  2. Dual response: htmx sends an `HX-Request` header, so the same endpoint
 *     returns a *fragment* to htmx and does Post/Redirect/Get (full page) for a
 *     plain browser form. Same affordance, two consumers, one set of controls.
 */

import express from "express";
import {
  CONTENDED_SLOT,
  freshSession,
  isAffordanceValid,
  type Session,
  slotIsFree,
} from "./model.ts";
import { confirmationPage, page, panel, slotsFragment } from "./render.ts";

// Single in-memory session (single-user demo; no login/DB by design).
let session: Session = freshSession();

const app = express();
app.use(express.urlencoded({ extended: false }));

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

// browsing → check availability (htmx: refresh only #slots)
app.get("/availability", (req, res) => {
  if (!guard(req, res, "check_availability")) return;
  session.date = String(req.query.date ?? "");
  session.partySize = Number(req.query.partySize ?? 2) || 2;
  if (isHtmx(req)) res.type("html").send(slotsFragment(session));
  else res.redirect(303, "/");
});

// browsing/conflict → hold a slot
app.post("/hold", (req, res) => {
  if (!guard(req, res, "hold_slot")) return;
  const slot = String(req.body.slot ?? "");
  if (!slotIsFree(session, slot)) {
    res.status(409).type("html").send(`<p>Slot ${slot} is not available.</p>`);
    return;
  }
  session.slot = slot;
  // If we already have the guest (came back here from a conflict), jump straight
  // to review; otherwise ask for details first.
  session.status = session.guest ? "details_entered" : "holding";
  respond(req, res);
});

// holding → change slot (native): back to browsing, keep date/party, drop slot
app.post("/change-slot", (req, res) => {
  if (!guard(req, res, "change_slot")) return;
  session.slot = undefined;
  session.status = "browsing";
  respond(req, res);
});

// holding → enter details
app.post("/details", (req, res) => {
  if (!guard(req, res, "enter_details")) return;
  session.guest = { name: String(req.body.name ?? ""), phone: String(req.body.phone ?? "") };
  session.status = "details_entered";
  respond(req, res);
});

// details_entered → edit details (native): back to holding to re-enter
app.post("/edit-details", (req, res) => {
  if (!guard(req, res, "edit_details")) return;
  session.status = "holding";
  respond(req, res);
});

// details_entered → confirm. The contended slot conflicts here, deterministically.
app.post("/confirm", (req, res) => {
  if (!guard(req, res, "confirm_booking")) return;
  if (session.slot === CONTENDED_SLOT) {
    session.status = "conflict";
  } else {
    session.status = "confirmed";
    session.bookingId = Math.random().toString(36).slice(2, 8).toUpperCase();
  }
  respond(req, res);
});

// release hold (htmx DELETE) → back to browsing
app.delete("/hold", (req, res) => {
  if (!guard(req, res, "release_hold")) return;
  session.slot = undefined;
  session.status = "browsing";
  respond(req, res);
});

// cancel / cancel_booking (htmx DELETE) → cancelled
app.delete("/booking", (req, res) => {
  if (!isAffordanceValid(session, "cancel") && !isAffordanceValid(session, "cancel_booking")) {
    res.status(409).type("html").send(`<p>Nothing to cancel in state <code>${session.status}</code>.</p>`);
    return;
  }
  session.status = "cancelled";
  respond(req, res);
});

// confirmed → view confirmation (native GET)
app.get("/confirmation", (req, res) => {
  if (!guard(req, res, "view_confirmation")) return;
  res.type("html").send(confirmationPage(session));
});

// start over
app.get("/reset", (_req, res) => {
  session = freshSession();
  res.redirect(303, "/");
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`B1 restaurant-booking site → http://localhost:${PORT}`);
});
