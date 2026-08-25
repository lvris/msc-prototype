/**
 * goals.ts — user intents, and the actions that satisfy them.
 *
 * Task prompts are built from these, never from action ids or endpoints: the
 * agent is told what the guest wants, not which control to press.
 *
 * The grouping is the load-bearing part. Two of the gates work precisely by
 * mapping ONE user intent onto DIFFERENT actions depending on server-held state:
 *
 *   "confirm the booking"  → `confirm_booking`, or `pay_deposit` for a large party
 *   "cancel the booking"   → `cancel_booking`, or `request_cancellation` within 24h
 *
 * So a task must be scored against the intent, not against one action id. A task
 * is satisfied if the agent performs ANY action in the intent's group; an agent
 * that fires the obvious member of the group in the state where the other member
 * is the valid one has made an invalid action, which is exactly the phenomenon
 * under measurement.
 *
 * `discard_draft` deliberately sits in its own intent: throwing away a draft is
 * not the same request as cancelling a booking that exists, and conflating the two
 * is the mistake G5 exists to expose.
 */

import type { ActionId } from "./model.ts";

export interface Intent {
  id: string;
  /** how a guest would put it — no endpoint, no action id, no state. */
  goal: string;
  /** every action that would satisfy this intent, in some state or other. */
  actions: ActionId[];
}

export const INTENTS: Intent[] = [
  { id: "find_availability", goal: "Find out which tables are free.", actions: ["check_availability"] },
  { id: "secure_table", goal: "Put a table on hold for us.", actions: ["hold_slot"] },
  { id: "join_queue", goal: "Get us in the queue for a table on that day.", actions: ["join_waitlist"] },
  { id: "leave_queue", goal: "Take us off the queue, we have made other plans.", actions: ["leave_waitlist"] },
  { id: "queue_position", goal: "Tell me how far up the queue we are.", actions: ["check_position"] },
  { id: "give_details", goal: "Put the booking under my name and phone number.", actions: ["enter_details"] },
  { id: "change_time", goal: "Actually, we would like a different time.", actions: ["change_slot"] },
  { id: "release_table", goal: "Let the table go, we do not want it after all.", actions: ["release_hold"] },
  {
    id: "finalize",
    goal: "Go ahead and confirm the booking.",
    actions: ["confirm_booking", "pay_deposit"],
  },
  { id: "fix_details", goal: "Fix the name on the booking.", actions: ["edit_details"] },
  {
    id: "abandon_draft",
    goal: "Forget this half-finished booking, we never completed it.",
    actions: ["discard_draft"],
  },
  { id: "start_preorder", goal: "We would like to order the food in advance.", actions: ["open_preorder"] },
  { id: "add_dish", goal: "Add the tiramisù to what we are ordering ahead.", actions: ["add_dish"] },
  { id: "remove_dish", goal: "Take that dish off the advance order.", actions: ["remove_dish"] },
  { id: "send_preorder", goal: "Send the advance food order to the kitchen.", actions: ["submit_preorder"] },
  { id: "see_confirmation", goal: "Show me the confirmation for the booking.", actions: ["view_confirmation"] },
  {
    id: "cancel_reservation",
    goal: "We cannot make it — cancel the booking.",
    actions: ["cancel_booking", "request_cancellation"],
  },
  {
    id: "see_cancellation",
    goal: "What is happening with the cancellation we asked for?",
    actions: ["view_cancellation"],
  },
  { id: "restart", goal: "Start again from scratch.", actions: ["start_over"] },
];

export const intentOf = (action: ActionId): Intent =>
  INTENTS.find((i) => i.actions.includes(action))!;
