# B1 — restaurant-booking hypermedia site

A minimal, browsable restaurant-reservation site for the MSc thesis demo. It is
the **B** side of the study: the server owns the booking state machine and, for
every state, renders **only the currently valid controls**. An invalid action is
therefore not "unlikely" — it is *unrepresentable*.

- **native HTML core**: `<a href>` and `<form action method>` carry the bulk of
  the flow (browse → hold → details → confirm).
- **htmx only at the boundaries native HTML can't self-describe**:
  - honest verbs beyond GET/POST — `release hold` / `cancel` use `hx-delete`;
  - partial update — `check availability` refreshes just the `#slots` panel via
    `hx-get` + `hx-target`.

Both are readable straight from the returned HTML (no JS execution needed), which
is what lets the future agent A consume the site by HTTP replay.

## Run

```
pnpm install        # once, from prototype/ (shared toolchain)
pnpm b1:dev         # http://localhost:3000
```

Walk the three flows in the browser:

1. **Happy path** — pick a date, *Check availability*, *Hold* a slot (not 20:00),
   enter details, *Confirm booking*.
2. **Locked** — once confirmed, the page has no change-slot / edit control, only
   *View confirmation* and *Cancel booking*.
3. **Conflict** — hold **20:00** (the contended slot) and confirm: it is taken at
   confirm time, the page shows **no "confirm anyway"** — only pick-another-slot.
   Choose another slot and confirm to resolve.

## Self-check

```
pnpm b1:check   # drives the 3 flows over HTTP, prints exposed affordances, asserts refusals
pnpm typecheck  # (whole prototype/)
```

## Files

| File | Role |
|------|------|
| `model.ts` | Booking state machine + `validAffordances()` — the authoritative valid-action set (pure logic). |
| `render.ts` | State → HTML: page shell, per-state panel, `renderAffordance()` (native / htmx). |
| `server.ts` | Express routes: HTTP → model transition → render; guard refuses invalid actions; htmx dual-response. |
| `check.ts` | Minimal HTTP self-check; seed of the future agent-A parsers. |

## Controlled JS-convenience list

Policy: JS may enhance *how a human picks* a value, but the submitted value must
land in a real named DOM input so every request is reconstructible from HTML
alone. Any true runtime-computed value (`hx-vals='js:{…}'`) is an explicit
exception and must be listed here so the agent knows what to special-case.

**Current exceptions: none.** Every request in B1 is reconstructible from the
HTML source (element attributes + in-scope named inputs).
