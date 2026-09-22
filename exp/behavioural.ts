/**
 * behavioural.ts — the INDEPENDENT judge.
 *
 * `judge.ts` answers "was that action valid here?" by reading `GET /__session`,
 * which hands back `validAffordances(session)` — the very function the site used
 * to render the page. That is the authoritative answer, but it is also the same
 * answer twice: the thing being measured and the thing measuring it are one
 * function. Every number in the evaluation therefore rests on an oracle that
 * cannot, by construction, disagree with the site.
 *
 * This module supplies a second opinion that shares none of that machinery. It
 * decides availability from BEHAVIOUR alone:
 *
 *   An action `a` is BEHAVIOURALLY AVAILABLE in state `s` iff there exists an
 *   assignment of values to `a`'s declared parameters such that issuing the
 *   corresponding HTTP request from `s` is not refused.
 *
 * "Not refused" is read off the status code only (`< 400`). The existential over
 * values matters: `hold_slot` is refused for a slot another party already took,
 * which is a fact about the ARGUMENTS, not about whether the action is available,
 * so a single sample value would misjudge it. Enumerating the candidates and
 * asking whether ANY of them goes through separates the two.
 *
 * What this file may and may not know:
 *
 *   MAY   `CATALOGUE` / `SAMPLE_VALUES` — which requests exist and how to build a
 *         well-formed one. A static catalogue says nothing about *when* an action
 *         is legal (catalogue.ts's own header makes that point), so knowing it
 *         gives the judge no access to the answer it is computing.
 *   MAY   `SLOTS` / `MENU` — the enumerable domains a parameter draws from, again
 *         needed only to build candidate requests.
 *   MAY   `POST /__session` — to pin the site to the state under test. This is a
 *         write, not an oracle.
 *   NEVER `validAffordances` / `isAffordanceValid` — the declarative answer.
 *   NEVER `GET /__session` — the endpoint that carries it. State movement is not
 *         consulted either, so no part of the harness oracle is read.
 *
 * `check-judges.ts` asserts the two judges agree. Their two disagreement classes
 * are not noise; each is a named property of the framework failing:
 *
 *   executed-but-not-declared  the guard let through an action the representation
 *                              does not offer  →  violates S1/S3 (design ch.)
 *   declared-but-not-executable an offered control could not be exercised with any
 *                              well-formed values  →  violates I3
 *
 * So the cross-check does not merely reassure: it re-derives those two invariants
 * from observable behaviour, without trusting the state machine that defines them.
 */

import { CATALOGUE, SAMPLE_VALUES } from "../b1/catalogue.ts";
import { MENU, type Session, SLOTS } from "../b1/model.ts";
import { exec, setSession } from "../b1/explore.ts";
import type { ActionId } from "../b1/model.ts";

/**
 * Candidate value assignments for one action, most likely first.
 *
 * Only two parameters have a domain worth enumerating. `slot` is the one that
 * genuinely decides availability (a taken slot is refused), and `dish` is
 * enumerated for the same reason at negligible cost. Every other parameter is
 * free-form and the server does not reject it on its value, so one sample is
 * enough — where that is not obviously true, a disagreement will surface it.
 */
function candidates(params: string[]): Record<string, string>[] {
  const base: Record<string, string> = {};
  for (const p of params) base[p] = SAMPLE_VALUES[p] ?? "x";

  if (params.includes("slot")) return SLOTS.map((slot) => ({ ...base, slot }));
  if (params.includes("dish")) return MENU.map((dish) => ({ ...base, dish }));
  return [base];
}

export interface Probe {
  id: ActionId;
  available: boolean;
  /** the assignment that went through, when one did. */
  accepted?: Record<string, string>;
  /** status codes seen, one per candidate tried, in order. */
  statuses: number[];
}

/**
 * Probe one action in one state. The session is re-pinned before every candidate
 * because a probe that succeeds has moved the state, and the next candidate must
 * be judged against `session`, not against whatever the last one produced.
 */
export async function probe(session: Session, id: ActionId): Promise<Probe> {
  const entry = CATALOGUE.find((e) => e.id === id);
  if (!entry) throw new Error(`no catalogue entry for ${id}`);

  const statuses: number[] = [];
  for (const values of candidates(entry.params)) {
    await setSession(session);
    const res = await exec(entry.method, entry.url, values);
    statuses.push(res.status);
    if (res.status < 400) return { id, available: true, accepted: values, statuses };
  }
  return { id, available: false, statuses };
}

/** Probe every catalogued action in one state. */
export async function probeAll(session: Session): Promise<Probe[]> {
  const out: Probe[] = [];
  for (const entry of CATALOGUE) out.push(await probe(session, entry.id));
  return out;
}

/** The behavioural verdict as a set, for comparison with `validAffordances`. */
export async function behaviourallyAvailable(session: Session): Promise<Set<ActionId>> {
  const probes = await probeAll(session);
  return new Set(probes.filter((p) => p.available).map((p) => p.id));
}
