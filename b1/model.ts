/**
 * model.ts — the booking state machine.
 *
 * This is the AUTHORITATIVE source of application state and, crucially, of the
 * set of *currently valid actions*. It is pure logic: it never touches HTTP or
 * HTML. `validAffordances(session)` is the thesis-load-bearing function — the
 * server renders exactly this set and nothing else, so an action that is not in
 * the set is not merely discouraged, it is unrepresentable.
 *
 * The design goal of the state machine is stated in one line:
 *
 *   the set of legal actions must be a function of SERVER-HELD STATE,
 *   not a function of the action names plus common sense.
 *
 * Five gates carry that property (see the guard predicates below):
 *
 *   G1 deposit threshold — party > LARGE_PARTY replaces `confirm_booking`
 *      with `pay_deposit`. The threshold lives only on the server.
 *   G2 cancellation window — within CANCEL_WINDOW_HOURS of seating,
 *      `cancel_booking` disappears and `request_cancellation` (which demands a
 *      reason) takes its place. Same user intent, different action.
 *   G3 pre-order window — the pre-order sub-resource can only be opened after
 *      details are entered and before the booking is confirmed, and locks once
 *      submitted. Availability of a sub-resource depends on the main resource.
 *   G4 waitlist non-monotonicity — when a date is full `hold_slot` vanishes and
 *      `join_waitlist` appears; when a table is released `hold_slot` comes back.
 *      The flow is not a one-way funnel.
 *   G5 same word, different action — "cancel" in `details_entered` is
 *      `discard_draft` (no fields, throws away a draft); in `confirmed` it is a
 *      real cancellation, possibly requiring a reason. One name is not one tool.
 */

export type Status =
  | "browsing"
  | "holding"
  | "details_entered"
  | "deposit_pending"
  | "confirmed"
  | "conflict"
  | "waitlisted"
  | "cancelled"
  | "cancellation_requested";

export type PreorderStatus = "none" | "open" | "submitted";

export interface Guest {
  name: string;
  phone: string;
}

export interface Preorder {
  status: PreorderStatus;
  dishes: string[];
}

export interface Session {
  status: Status;
  /** id of a row in `DATES`; undefined until availability has been checked. */
  date?: string;
  partySize?: number;
  slot?: string;
  guest?: Guest;
  bookingId?: string;
  preorder: Preorder;
  /** set once a deposit has been taken (G1). */
  depositPaid?: boolean;
  /** position in the waitlist queue, server-assigned (G4). */
  waitlistPosition?: number;
  /** the queue has been polled at least once — a table has since been released (G4). */
  waitlistPolled?: boolean;
  /** slot lost to another party at confirmation time; taken from here on. */
  conflictSlot?: string;
  cancellationReason?: string;
}

export type Method = "GET" | "POST" | "PUT" | "DELETE";
export type AffordanceKind = "native" | "htmx";

export interface Field {
  name: string;
  type: "text" | "tel" | "hidden" | "number" | "date" | "select" | "textarea";
  value?: string;
  label?: string;
  required?: boolean;
  /** enumerated choices, for `select`. */
  options?: { value: string; label: string }[];
}

/**
 * A normalized affordance descriptor. This is deliberately the same shape the
 * agent A parsers normalize native/htmx controls into: `{ method, url, fields }`.
 * The site produces them from the model; the agent re-derives them from HTML.
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

// ── Server-held facts ────────────────────────────────────────────────────────
// Everything below is knowable only by asking the server. The agent cannot infer
// any of it from the action names, and that is the point.

/** All bookable time slots for the (single, in-memory) restaurant. */
export const SLOTS = ["17:00", "18:00", "19:00", "20:00", "21:00"] as const;

/** Above this party size a deposit is required instead of a plain confirm (G1). */
export const LARGE_PARTY = 6;

/** Within this many hours of seating, cancellation becomes a request (G2). */
export const CANCEL_WINDOW_HOURS = 24;

/** Deposit charged per guest, in euro (G1). */
export const DEPOSIT_PER_GUEST = 10;

/**
 * The "popular" slot. It looks free while you browse and hold, but another party
 * takes it the moment you try to confirm — the deterministic `conflict` source.
 */
export const CONTENDED_SLOT = "20:00";

/** The table that frees up once a waitlisted guest polls their position (G4). */
export const RELEASED_SLOT = "19:00";

export interface BookingDate {
  id: string;
  label: string;
  /** distance from now to seating; straddles CANCEL_WINDOW_HOURS by design (G2). */
  hoursUntilSeating: number;
  /** slots already booked by other parties on this date. */
  taken: string[];
}

/**
 * Dates are pre-baked rather than derived from a clock: the two sides of the
 * cancellation window and the full/not-full distinction must be reproducible
 * across runs, and nothing in the thesis depends on real time.
 */
export const DATES: BookingDate[] = [
  // inside the cancellation window → G2 takes the `request_cancellation` branch
  { id: "tomorrow", label: "Tomorrow", hoursUntilSeating: 20, taken: ["17:00", "21:00"] },
  // outside the window → G2 takes the `cancel_booking` branch
  { id: "next-week", label: "Next Wednesday", hoursUntilSeating: 168, taken: ["18:00"] },
  // fully booked → G4 offers the waitlist instead of a hold
  { id: "saturday", label: "This Saturday", hoursUntilSeating: 54, taken: [...SLOTS] },
];

/** The dishes that may be pre-ordered (G3). */
export const MENU = ["Bruschetta", "Tagliatelle al ragù", "Tiramisù"] as const;

/**
 * Match a submitted value against the set the server permits, tolerantly.
 *
 * Returns the server's own spelling if the input unambiguously denotes one of
 * the permitted values, and `undefined` if it denotes none of them.
 *
 * WHY THIS IS NOT LENIENCY FOR ITS OWN SAKE. The evaluation counts a class of
 * failure it calls "right action, wrong value": the agent named an operation the
 * state allows, and supplied a value the server would not take. That is a
 * meaningful failure only when the value is genuinely not one the server offers.
 * An exact-match check also rejects `tiramisù` for `Tiramisù` — a difference in
 * casing, whitespace or Unicode normalisation, not in what was meant — and
 * filing that under "wrong value" would inflate the measurement with a fact
 * about string comparison rather than about the interface.
 *
 * Case folding, trimming and NFC are the three ways the same intended string
 * arrives looking different: composed vs decomposed accents (`ù` as one code
 * point or as `u` + combining grave), copied-in leading spaces, and the casing
 * of a word lifted out of a sentence. None of them is the agent being wrong
 * about the menu.
 *
 * What survives this is the failure the thesis is actually about: the permitted
 * values are server state, carried inside the control that consumes them and
 * absent from any out-of-band schema. A rendered `<select>` cannot name a dish
 * the kitchen does not serve; a parameter typed `string` has nothing to stop it.
 */
const fold = (s: string): string => s.normalize("NFC").trim().toLocaleLowerCase();

export function canonicalise(
  value: string,
  permitted: readonly string[],
): string | undefined {
  const target = fold(value);
  return permitted.find((p) => fold(p) === target);
}

export function freshSession(): Session {
  return { status: "browsing", preorder: { status: "none", dishes: [] } };
}

export const dateInfo = (session: Session): BookingDate | undefined =>
  DATES.find((d) => d.id === session.date);

// ── Derived server facts ─────────────────────────────────────────────────────

/** G1: does this party size push the booking onto the deposit branch? */
export function needsDeposit(session: Session): boolean {
  return (session.partySize ?? 0) > LARGE_PARTY;
}

/** G1: what the deposit costs, once it is required. */
export function depositAmount(session: Session): number {
  return (session.partySize ?? 0) * DEPOSIT_PER_GUEST;
}

/** G2: is the booking inside the cancellation window? */
export function insideCancelWindow(session: Session): boolean {
  const d = dateInfo(session);
  return d !== undefined && d.hoursUntilSeating <= CANCEL_WINDOW_HOURS;
}

/** Slots offered for the chosen date, with a taken flag. */
export function slotOptions(session: Session): { slot: string; taken: boolean }[] {
  const d = dateInfo(session);
  if (!d) return [];
  const taken = new Set(d.taken);
  // G4: polling the waitlist reveals that a table has been released. The set of
  // holdable slots therefore GROWS — the flow is not a one-way funnel.
  if (session.waitlistPolled) taken.delete(RELEASED_SLOT);
  // a slot lost at confirmation time stays lost
  if (session.conflictSlot) taken.add(session.conflictSlot);
  return SLOTS.map((slot) => ({ slot, taken: taken.has(slot) }));
}

export const freeSlots = (session: Session): string[] =>
  slotOptions(session).filter((o) => !o.taken).map((o) => o.slot);

/** Is a given slot currently free to hold? */
export const slotIsFree = (session: Session, slot: string): boolean =>
  freeSlots(session).includes(slot);

/** G4: no table left on this date. */
export const isFullyBooked = (session: Session): boolean =>
  session.date !== undefined && freeSlots(session).length === 0;

// ── Affordance builders ──────────────────────────────────────────────────────

/** One native "hold this slot" affordance per free slot. */
export function slotAffordances(session: Session): Affordance[] {
  return freeSlots(session).map((slot) => ({
    id: "hold_slot",
    label: `Hold ${slot}`,
    method: "POST",
    url: "/hold",
    kind: "native",
    fields: [{ name: "slot", type: "hidden", value: slot }],
  }));
}

/** Hold-or-waitlist: the two are mutually exclusive and the server decides (G4). */
function slotOrWaitlistAffordances(session: Session): Affordance[] {
  if (session.date === undefined) return [];
  if (isFullyBooked(session)) {
    return [
      {
        id: "join_waitlist",
        label: "Join the waitlist",
        method: "POST",
        url: "/waitlist",
        kind: "native",
      },
    ];
  }
  return slotAffordances(session);
}

/** The pre-order sub-resource's own controls (G3). */
function preorderAffordances(session: Session): Affordance[] {
  if (session.preorder.status !== "open") return [];
  const remove: Affordance[] = session.preorder.dishes.map((dish, i) => ({
    id: "remove_dish",
    label: `Remove ${dish}`,
    method: "DELETE",
    url: "/preorder/dishes",
    kind: "htmx", // boundary: honest DELETE verb
    target: "#booking",
    swap: "innerHTML",
    fields: [
      { name: "dish", type: "hidden", value: dish },
      { name: "index", type: "hidden", value: String(i) },
    ],
  }));
  return [
    {
      id: "add_dish",
      label: "Add dish",
      method: "POST",
      url: "/preorder/dishes",
      kind: "native",
      fields: [
        {
          name: "dish",
          type: "select",
          label: "Dish",
          required: true,
          value: MENU[0],
          options: MENU.map((d) => ({ value: d, label: d })),
        },
      ],
    },
    ...remove,
    {
      id: "submit_preorder",
      label: "Submit pre-order",
      method: "POST",
      url: "/preorder/submit",
      kind: "native",
    },
  ];
}

/** The draft-stage controls shared by `details_entered` and `deposit_pending`. */
function draftAffordances(session: Session): Affordance[] {
  return [
    {
      id: "edit_details",
      label: "Edit details",
      method: "POST",
      url: "/edit-details",
      kind: "native",
    },
    {
      // G5: this is NOT `cancel_booking`. It throws away an unconfirmed draft,
      // needs no reason, and lives at a different URL.
      id: "discard_draft",
      label: "Discard draft",
      method: "DELETE",
      url: "/draft",
      kind: "htmx", // boundary: honest DELETE verb
      target: "#booking",
      swap: "innerHTML",
    },
    ...preorderAffordances(session),
  ];
}

/**
 * The valid action set for the CURRENT state. Rendering and server-side guarding
 * both flow from this one function.
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
            {
              name: "date",
              type: "select",
              label: "Date",
              required: true,
              value: session.date ?? DATES[0].id,
              options: DATES.map((d) => ({ value: d.id, label: d.label })),
            },
            {
              name: "partySize",
              type: "number",
              label: "Party size",
              value: String(session.partySize ?? 2),
              required: true,
            },
          ],
        },
        ...slotOrWaitlistAffordances(session),
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
      // G1: this branch exists only for parties at or below the threshold. A
      // large party never sees `confirm_booking` at all.
      return [
        {
          id: "confirm_booking",
          label: "Confirm booking",
          method: "POST",
          url: "/confirm",
          kind: "native",
        },
        // G3: the pre-order window opens here and nowhere else.
        ...(session.preorder.status === "none"
          ? [
              {
                id: "open_preorder",
                label: "Pre-order food",
                method: "POST" as Method,
                url: "/preorder",
                kind: "native" as AffordanceKind,
              },
            ]
          : []),
        ...draftAffordances(session),
      ];

    case "deposit_pending":
      // G1: no confirm here — the only way forward is through the deposit.
      return [
        {
          id: "pay_deposit",
          label: `Pay €${depositAmount(session)} deposit`,
          method: "POST",
          url: "/deposit",
          kind: "native",
          fields: [
            { name: "card", type: "text", label: "Card number", required: true },
          ],
        },
        ...draftAffordances(session),
      ];

    case "confirmed":
      // NOTE: no change-slot / edit affordance. Once confirmed the booking is
      // locked; those actions are unrepresentable.
      return [
        {
          id: "view_confirmation",
          label: "View confirmation",
          method: "GET",
          url: "/confirmation",
          kind: "native",
        },
        // G2 + G5: which cancellation exists depends on how far away seating is.
        ...(insideCancelWindow(session)
          ? [
              {
                id: "request_cancellation",
                label: "Request cancellation",
                method: "POST" as Method,
                url: "/cancellation-request",
                kind: "native" as AffordanceKind,
                fields: [
                  {
                    name: "reason",
                    type: "textarea" as const,
                    label: "Reason (required within 24h of seating)",
                    required: true,
                  },
                ],
              },
            ]
          : [
              {
                id: "cancel_booking",
                label: "Cancel booking",
                method: "DELETE" as Method,
                url: "/booking",
                kind: "htmx" as AffordanceKind, // boundary: honest DELETE verb
                target: "#booking",
                swap: "innerHTML",
              },
            ]),
      ];

    case "conflict":
      // NOTE: no confirm affordance. "Confirm anyway" is not a refused request —
      // it simply is not among the offered controls. Pick another slot, or, if
      // the date is now full, take the waitlist (G4).
      return slotOrWaitlistAffordances(session);

    case "waitlisted":
      return [
        {
          id: "check_position",
          label: "Check queue position",
          method: "GET",
          url: "/waitlist",
          kind: "native",
        },
        {
          id: "leave_waitlist",
          label: "Leave the waitlist",
          method: "DELETE",
          url: "/waitlist",
          kind: "htmx", // boundary: honest DELETE verb
          target: "#booking",
          swap: "innerHTML",
        },
        // G4: a table released while queueing puts `hold_slot` back on the page.
        ...slotAffordances(session),
      ];

    case "cancellation_requested":
      return [
        {
          id: "view_cancellation",
          label: "View cancellation request",
          method: "GET",
          url: "/cancellation",
          kind: "native",
        },
        {
          id: "start_over",
          label: "Start over",
          method: "GET",
          url: "/reset",
          kind: "native",
        },
      ];

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

/** Every action id the site knows about — the "catalogue" a tool-list agent gets. */
export const ALL_ACTION_IDS = [
  "check_availability",
  "hold_slot",
  "join_waitlist",
  "leave_waitlist",
  "check_position",
  "enter_details",
  "change_slot",
  "release_hold",
  "confirm_booking",
  "pay_deposit",
  "edit_details",
  "discard_draft",
  "open_preorder",
  "add_dish",
  "remove_dish",
  "submit_preorder",
  "view_confirmation",
  "cancel_booking",
  "request_cancellation",
  "view_cancellation",
  "start_over",
] as const;

export type ActionId = (typeof ALL_ACTION_IDS)[number];

/**
 * Server-side guard: is `id` a currently valid action? This backs up the
 * "only valid controls are rendered" property with "invalid requests are
 * refused", so a hand-crafted request cannot bypass the state machine either.
 */
export function isAffordanceValid(session: Session, id: string): boolean {
  return validAffordances(session).some((a) => a.id === id);
}
