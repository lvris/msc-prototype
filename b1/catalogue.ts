/**
 * catalogue.ts — the STATIC action catalogue.
 *
 * Every action the site can ever perform, described the way a conventional
 * tool-calling agent would be given it: a fixed list of endpoints with fixed
 * parameters, decided once at design time. It says nothing about *when* an
 * action is legal, because a static catalogue structurally cannot.
 *
 * This file exists for two consumers:
 *
 *  1. the invariant checker (I2), which fires every catalogued action at every
 *     reachable state and asserts that the ones outside `validAffordances()` are
 *     refused; and
 *  2. the experiment conditions J and J+, whose tool list is exactly this table
 *     (J+ additionally receives the prose in `note`).
 *
 * It is deliberately NOT imported by the model, the renderer, or the server: the
 * site's behaviour must not depend on it, or the comparison would be rigged.
 */

import { DATES, MENU, type ActionId, type Method } from "./model.ts";

export interface CatalogueEntry {
  id: ActionId;
  method: Method;
  url: string;
  /** parameter names the endpoint accepts, as a static catalogue would list them. */
  params: string[];
  /** one-line description, the kind a tool schema carries. */
  description: string;
  /**
   * The extra prose the J+ condition gets: the precondition stated in words.
   * J receives `description` only; J+ receives `description` + `note`. Neither
   * receives the current state, which is the whole point of the comparison.
   */
  note?: string;
}

export const CATALOGUE: CatalogueEntry[] = [
  {
    id: "check_availability",
    method: "GET",
    url: "/availability",
    params: ["date", "partySize"],
    description: "List the tables free on a given date for a given party size.",
    note: "Only meaningful before a table is held.",
  },
  {
    id: "hold_slot",
    method: "POST",
    url: "/hold",
    params: ["slot"],
    description: "Put a temporary hold on a time slot.",
    note: "Only possible if that slot is still free; a fully booked date offers the waitlist instead.",
  },
  {
    id: "join_waitlist",
    method: "POST",
    url: "/waitlist",
    params: [],
    description: "Join the queue for a table on the chosen date.",
    note: "Only offered when no slot on the date is free.",
  },
  {
    id: "leave_waitlist",
    method: "DELETE",
    url: "/waitlist",
    params: [],
    description: "Leave the waitlist queue.",
    note: "Only while queued.",
  },
  {
    id: "check_position",
    method: "GET",
    url: "/waitlist",
    params: [],
    description: "Read your current position in the waitlist queue.",
    note: "Only while queued.",
  },
  {
    id: "enter_details",
    method: "POST",
    url: "/details",
    params: ["name", "phone"],
    description: "Attach the guest's name and phone number to the held table.",
    note: "Only while a table is held.",
  },
  {
    id: "change_slot",
    method: "POST",
    url: "/change-slot",
    params: [],
    description: "Give up the held slot and return to the slot list.",
    note: "Only while a table is held and not yet confirmed.",
  },
  {
    id: "release_hold",
    method: "DELETE",
    url: "/hold",
    params: [],
    description: "Release the temporary hold on the slot.",
    note: "Only while a table is held.",
  },
  {
    id: "confirm_booking",
    method: "POST",
    url: "/confirm",
    params: [],
    description: "Turn the reviewed draft into a confirmed booking.",
    note: "Only for parties that do not require a deposit; large parties must pay a deposit instead.",
  },
  {
    id: "pay_deposit",
    method: "POST",
    url: "/deposit",
    params: ["card"],
    description: "Pay the deposit a large party requires, which also confirms the booking.",
    note: "Only when the party size is above the restaurant's threshold.",
  },
  {
    id: "edit_details",
    method: "POST",
    url: "/edit-details",
    params: [],
    description: "Go back and re-enter the guest details.",
    note: "Only before the booking is confirmed.",
  },
  {
    id: "discard_draft",
    method: "DELETE",
    url: "/draft",
    params: [],
    description: "Throw away the unconfirmed draft booking.",
    note: "Only before confirmation; this is not the same action as cancelling a confirmed booking.",
  },
  {
    id: "open_preorder",
    method: "POST",
    url: "/preorder",
    params: [],
    description: "Start a food pre-order for the booking.",
    note: "Only after details are entered and before the booking is confirmed.",
  },
  {
    id: "add_dish",
    method: "POST",
    url: "/preorder/dishes",
    params: ["dish"],
    description: "Add a dish to the pre-order.",
    note: "Only while the pre-order is open and not yet submitted.",
  },
  {
    id: "remove_dish",
    method: "DELETE",
    url: "/preorder/dishes",
    params: ["dish", "index"],
    description: "Remove a dish from the pre-order.",
    note: "Only while the pre-order is open and not yet submitted.",
  },
  {
    id: "submit_preorder",
    method: "POST",
    url: "/preorder/submit",
    params: [],
    description: "Submit the pre-order, locking it.",
    note: "Only while the pre-order is open.",
  },
  {
    id: "view_confirmation",
    method: "GET",
    url: "/confirmation",
    params: [],
    description: "Read the confirmation page for the booking.",
    note: "Only once the booking is confirmed.",
  },
  {
    id: "cancel_booking",
    method: "DELETE",
    url: "/booking",
    params: [],
    description: "Cancel a confirmed booking outright.",
    note: "Only when seating is more than 24 hours away; closer than that, a cancellation must be requested.",
  },
  {
    id: "request_cancellation",
    method: "POST",
    url: "/cancellation-request",
    params: ["reason"],
    description: "Ask the restaurant to cancel a booking, giving a reason.",
    note: "Only within 24 hours of seating; earlier than that, the booking can simply be cancelled.",
  },
  {
    id: "view_cancellation",
    method: "GET",
    url: "/cancellation",
    params: [],
    description: "Read the status of a pending cancellation request.",
    note: "Only after a cancellation has been requested.",
  },
  {
    id: "start_over",
    method: "GET",
    url: "/reset",
    params: [],
    description: "Abandon everything and start a new session.",
    note: "Only from a finished session.",
  },
];

/**
 * Parameters whose permitted values are a FIXED fact about the application.
 *
 * The menu does not change with the booking, and neither does the list of dates
 * the restaurant takes reservations for. A static catalogue can therefore state
 * them, and a static tool schema can put them in a JSON Schema `enum`. Any
 * competent author of either would, so withholding them would not be measuring a
 * limitation of catalogues — it would be measuring a catalogue written badly, and
 * the baseline is supposed to get the strongest honest form of itself.
 *
 * WHAT IS DELIBERATELY ABSENT. `slot` is not here. Which sittings are free is a
 * fact about the current state, not about the application, so no fixed table can
 * carry it — that is the distinction the whole experiment turns on, and
 * `b1/mcp.ts` adds it for the dynamic condition alone.
 *
 * `card`, `phone`, `name` and `reason` are not here either, for the opposite
 * reason: they have no permitted set. Only the user knows them, which is what
 * makes them elicitation rather than selection.
 */
export const STATIC_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  dish: MENU,
  date: DATES.map((d) => d.id),
};

/** Plausible values for every parameter in the catalogue, so a request can be built. */
export const SAMPLE_VALUES: Record<string, string> = {
  date: "next-week",
  partySize: "2",
  slot: "19:00",
  name: "Ada Lovelace",
  phone: "+358 40 123 4567",
  card: "4242 4242 4242 4242",
  reason: "Travel plans changed.",
  dish: "Tiramisù",
  index: "0",
};

export const entryFor = (id: string): CatalogueEntry | undefined =>
  CATALOGUE.find((e) => e.id === id);
