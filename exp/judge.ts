/**
 * judge.ts — ground truth for "was that action valid here?".
 *
 * The judgement is not a heuristic and not a second model: before each step the
 * harness reads `/__session`, which returns the very set `validAffordances()`
 * produced for the current state. Whether the agent's chosen action is in that set
 * is then a set-membership test on the server's own answer.
 *
 * ⚠️ Under condition H the answer is true by construction — the agent could only
 * choose from what the server rendered, and I1 asserts rendered == valid. That is
 * a STRUCTURAL GUARANTEE, not a measurement, and the thesis must say so where the
 * number appears. The measured quantity is J / J+.
 */

import type { Affordance } from "../a/affordance.ts";
import { CATALOGUE } from "../b1/catalogue.ts";
import type { ActionId, Session } from "../b1/model.ts";

export interface Snapshot {
  session: Session;
  /** ids the server considers legal right now. */
  validIds: ActionId[];
}

/**
 * (method, path) → action id. Unique across the catalogue by construction: the
 * verb carries the meaning wherever a path is reused (POST /waitlist joins,
 * DELETE /waitlist leaves, GET /waitlist reads the position).
 */
const BY_ROUTE = new Map(CATALOGUE.map((e) => [`${e.method} ${e.url}`, e.id]));

/** Which catalogued action a chosen affordance actually fires. Null = off-catalogue. */
export function actionIdOf(a: Affordance, base: string): ActionId | null {
  const path = new URL(a.url || "/", base).pathname;
  return BY_ROUTE.get(`${a.method} ${path}`) ?? null;
}

export async function snapshot(base: string): Promise<Snapshot> {
  const r = await fetch(`${base}/__session`);
  const data = (await r.json()) as { session: Session; valid: { id: ActionId }[] };
  return { session: data.session, validIds: data.valid.map((v) => v.id) };
}

export async function resetTo(base: string, session: Partial<Session>): Promise<void> {
  await fetch(`${base}/__session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(session),
  });
}
