# B1 — restaurant-booking hypermedia site

A minimal, browsable restaurant-reservation site for the MSc thesis study. It is
the **B** side: the server owns the booking state machine and, for every state,
renders **only the currently valid controls**. An invalid action is therefore not
"unlikely" — it is *unrepresentable*.

- **native HTML core**: `<a href>` and `<form action method>` carry the bulk of
  the flow (browse → hold → details → confirm).
- **htmx only at the boundaries native HTML can't self-describe**:
  - honest verbs beyond GET/POST — `release hold` / `discard draft` / `cancel`
    use `hx-delete`;
  - partial update — `check availability` refreshes just the `#slots` panel via
    `hx-get` + `hx-target`.

Both are readable straight from the returned HTML (no JS execution needed), which
is what lets agent A consume the site by HTTP replay.

## The five gates

The site is designed around one requirement: **the set of legal actions must be a
function of server-held state, not of the action names plus common sense.** If it
were guessable, an agent given a static tool catalogue would do just as well as
one reading the rendered controls, and the comparison would measure nothing.

| Gate | Rule | The assumption it attacks |
|------|------|---------------------------|
| **G1** deposit threshold | party > `LARGE_PARTY` ⇒ no `confirm_booking`, only `pay_deposit` | the threshold lives only on the server |
| **G2** cancellation window | within `CANCEL_WINDOW_HOURS` ⇒ no `cancel_booking`, only `request_cancellation` (needs a reason) | one intent, different actions at different times |
| **G3** pre-order window | openable only after details and before confirmation; locked once submitted | a sub-resource's availability depends on the main resource |
| **G4** waitlist non-monotonicity | a full date hides `hold_slot` and offers `join_waitlist`; a released table brings `hold_slot` back | the flow is not a one-way funnel |
| **G5** same word, different action | `discard_draft` (unconfirmed, no fields) is not `cancel_booking` (confirmed, real consequences) | one name is not one tool |

21 actions in the catalogue; **2.87 valid per state on average** — a static tool
list over-offers by roughly **7:1**.

## Run

```
pnpm install        # once, from prototype/ (shared toolchain)
pnpm b1:dev         # http://localhost:3000
```

Things worth walking through in a browser:

1. **Happy path** — pick a date, *Check availability*, *Hold* a slot (not 20:00),
   enter details, *Confirm booking*.
2. **Deposit (G1)** — repeat with a party of 8: there is no *Confirm booking*
   button at all, only *Pay deposit*.
3. **Cancellation window (G2)** — book *Tomorrow* vs *Next Wednesday* and compare
   what the confirmed page offers.
4. **Conflict** — hold **20:00** (the contended slot) and confirm: it is taken at
   confirm time, and the page shows **no "confirm anyway"**.
5. **Waitlist (G4)** — pick *This Saturday* (fully booked): only the waitlist is
   offered; join it, check your position, and a table appears.

## Checks and generated artefacts

```
pnpm b1:check   # I1–I6 over every reachable state (~35 s, ~52k assertions)
pnpm b1:tasks   # derive the experiment task set → ../exp/tasks.json
pnpm typecheck  # (whole prototype/)
```

`b1:check` asserts the executable form of the thesis's claims, over the **whole**
reachable state space rather than a hand-picked scenario:

| | Invariant |
|---|---|
| **I1** | the controls parsed out of the HTML are *exactly* `validAffordances(s)` — both inclusions |
| **I2** | every catalogued action outside the valid set is refused (409) and changes nothing |
| **I3** | every rendered control, replayed as declared, succeeds and (if mutating) moves the state |
| **I4** | every status is reachable from a fresh session, with a printed witness path |
| **I5** | the declared fields suffice; no undeclared required parameter exists |
| **I6** | for G1–G5, the two sides of the gate really do expose different action sets |

## Files

| File | Role |
|------|------|
| `model.ts` | Booking state machine + `validAffordances()` — the authoritative valid-action set (pure logic). |
| `render.ts` | State → HTML: page shell, per-state panel, `renderAffordance()` (native / htmx). |
| `server.ts` | Express routes: HTTP → model transition → render; guard refuses invalid actions; htmx dual-response. Plus `/__session`, a harness-only endpoint that is never rendered. |
| `catalogue.ts` | The *static* action catalogue — what a conventional tool-calling agent would be handed. Used by the checker (I2) and by the J / J+ experiment conditions. Deliberately not imported by the site itself. |
| `goals.ts` | User intents and the actions that satisfy them. Two intents map to two actions each — that is G1 and G2. |
| `explore.ts` | Breadth-first walk of the whole site through controls discovered in HTML; shared by the checker and the task generator. |
| `check.ts` | The invariant checker (I1–I6). |
| `tasks.ts` | Derives the experiment task set from the reachability graph. |

## Controlled JS-convenience list

Policy: JS may enhance *how a human picks* a value, but the submitted value must
land in a real named DOM input so every request is reconstructible from HTML
alone. Any true runtime-computed value (`hx-vals='js:{…}'`) is an explicit
exception and must be listed here so the agent knows what to special-case.

**Current exceptions: none.** Every request in B1 is reconstructible from the
HTML source (element attributes + in-scope named inputs).
