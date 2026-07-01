/**
 * model.ts — the booking state machine.
 *
 * This is the AUTHORITATIVE source of application state and, crucially, of the
 * set of *currently valid actions*. It is pure logic: it never touches HTTP or
 * HTML. `validAffordances(session)` is the thesis-load-bearing function — the
 * server renders exactly this set and nothing else, so an action that is not in
 * the set is not merely discouraged, it is unrepresentable.
 */

export type Status =
  | "browsing"
  | "holding"
  | "details_entered"
  | "confirmed"
  | "conflict"
  | "cancelled";

export interface Guest {
  name: string;
  phone: string;
}

export interface Session {
  status: Status;
  date?: string;
  partySize?: number;
  slot?: string;
  guest?: Guest;
  bookingId?: string;
}

export type Method = "GET" | "POST" | "PUT" | "DELETE";
export type AffordanceKind = "native" | "htmx";

export interface Field {
  name: string;
  type: "text" | "tel" | "hidden" | "number" | "date";
  value?: string;
  label?: string;
  required?: boolean;
}

/**
 * A normalized affordance descriptor. This is deliberately the same shape the
 * (future) agent A parsers will normalize native/htmx controls into:
 * `{ id, method, url, fields, target? }`. The demo produces them from the model;
 * the agent will re-derive them from the returned HTML.
 */
export interface Affordance {
  id: string;
  label: string;
  method: Method;
  url: string;
  kind: AffordanceKind;
  fields?: Field[];
  /** htmx-only presentation hints (which fragment the response replaces). */
  target?: string;
  swap?: string;
}

/** All bookable time slots for the (single, in-memory) restaurant. */
export const SLOTS = ["17:00", "18:00", "19:00", "20:00", "21:00"] as const;

/**
 * The "popular" slot. It looks free while you browse and hold, but it gets
 * taken by someone else the moment you try to confirm — this is what drives the
 * deterministic `conflict` demo. Choose any other slot for the happy path.
 */
export const CONTENDED_SLOT = "20:00";

export function freshSession(): Session {
  return { status: "browsing" };
}

/** Slots offered for holding, with a taken flag. */
export function slotOptions(session: Session): { slot: string; taken: boolean }[] {
  return SLOTS.map((slot) => ({
    // In `conflict` the contended slot is shown as taken so the user must pick
    // another one; everywhere else all slots look free.
    slot,
    taken: session.status === "conflict" && slot === CONTENDED_SLOT,
  }));
}

/** One native "hold this slot" affordance per free slot. */
export function slotAffordances(session: Session): Affordance[] {
  return slotOptions(session)
    .filter((o) => !o.taken)
    .map((o) => ({
      id: "hold_slot",
      label: `Hold ${o.slot}`,
      method: "POST",
      url: "/hold",
      kind: "native",
      fields: [{ name: "slot", type: "hidden", value: o.slot }],
    }));
}

/**
 * The valid action set for the CURRENT state's main panel. Rendering and
 * server-side guarding both flow from this one function.
 */
export function validAffordances(session: Session): Affordance[] {
  switch (session.status) {
    case "browsing":
      return [
        {
          id: "check_availability",
          label: "Check availability",
          method: "GET",
          url: "/availability",
          kind: "htmx", // boundary: partial refresh of just the #slots panel
          target: "#slots",
          swap: "innerHTML",
          fields: [
            // default to today so the very first click already returns slots
            { name: "date", type: "date", label: "Date", value: new Date().toISOString().slice(0, 10), required: true },
            { name: "partySize", type: "number", label: "Party size", value: "2", required: true },
          ],
        },
      ];

    case "holding":
      return [
        {
          id: "enter_details",
          label: "Continue",
          method: "POST",
          url: "/details",
          kind: "native",
          fields: [
            { name: "name", type: "text", label: "Name", required: true },
            { name: "phone", type: "tel", label: "Phone", required: true },
          ],
        },
        {
          id: "change_slot",
          label: "Change slot",
          method: "POST",
          url: "/change-slot",
          kind: "native",
        },
        {
          id: "release_hold",
          label: "Release hold",
          method: "DELETE",
          url: "/hold",
          kind: "htmx", // boundary: honest DELETE verb
          target: "#booking",
          swap: "innerHTML",
        },
      ];

    case "details_entered":
      return [
        {
          id: "confirm_booking",
          label: "Confirm booking",
          method: "POST",
          url: "/confirm",
          kind: "native",
        },
        {
          id: "edit_details",
          label: "Edit details",
          method: "POST",
          url: "/edit-details",
          kind: "native",
        },
        {
          id: "cancel",
          label: "Cancel",
          method: "DELETE",
          url: "/booking",
          kind: "htmx", // boundary: honest DELETE verb
          target: "#booking",
          swap: "innerHTML",
        },
      ];

    case "confirmed":
      // NOTE: there is deliberately no change-slot / edit affordance here.
      // Once confirmed the booking is locked; the action is unrepresentable.
      return [
        {
          id: "view_confirmation",
          label: "View confirmation",
          method: "GET",
          url: "/confirmation",
          kind: "native",
        },
        {
          id: "cancel_booking",
          label: "Cancel booking",
          method: "DELETE",
          url: "/booking",
          kind: "htmx", // boundary: honest DELETE verb
          target: "#booking",
          swap: "innerHTML",
        },
      ];

    case "conflict":
      // NOTE: there is deliberately no confirm affordance here. "Confirm anyway"
      // is not a refused request — it simply is not among the offered controls.
      // The only way forward is to pick another slot.
      return slotAffordances(session);

    case "cancelled":
      return [
        {
          id: "start_over",
          label: "Start over",
          method: "GET",
          url: "/reset",
          kind: "native",
        },
      ];
  }
}

/**
 * Server-side guard: is `id` a currently valid action? This backs up the
 * "only valid controls are rendered" property with "invalid requests are
 * refused", so a hand-crafted request cannot bypass the state machine either.
 */
export function isAffordanceValid(session: Session, id: string): boolean {
  if (id === "hold_slot") {
    return session.status === "browsing" || session.status === "conflict";
  }
  return validAffordances(session).some((a) => a.id === id);
}

/** Is a given slot currently free to hold? */
export function slotIsFree(session: Session, slot: string): boolean {
  const opt = slotOptions(session).find((o) => o.slot === slot);
  return opt !== undefined && !opt.taken;
}
