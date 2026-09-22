# Prototype — hypermedia-constrained agent over hypermedia sites

Engineering artifact for the thesis *Hypermedia-Constrained Generative UI*. One
**fixed generic agent** (`a/`) consumes one or more **hypermedia sites**
(`b1/`, `b2/`, …). The agent has zero site-specific knowledge; each site is a
self-contained, independently runnable app. The shared toolchain lives at the
top level so instances stay small.

## Layout

```
prototype/
├── package.json          shared deps + per-instance scripts
├── tsconfig.json         one config, includes a/ b1/ b2/
├── pnpm-workspace.yaml   pnpm 11 build-script settings
├── a/                    the fixed generic agent (parsers + discovery loop) ✅
├── b1/                   restaurant-booking site  (native HTML core + htmx boundaries) ✅
│   └── mcp.ts            the same site's MCP server — a baseline, not the thesis ✅
├── exp/                  the experiment: six surfaces, one loop, one log schema ✅
└── b2/                   a second site in a different vocabulary/framework — future
```

`b1/mcp.ts` is worth a word, since it is the thing the thesis argues against: a
second, machine-only contract over an application that already has one. It is
here so the comparison runs against a real MCP server rather than against our
impression of one — the baseline gets the strongest honest form of itself, and
`exp/check-mcp.ts` asserts it really is that form.

**Naming convention:** `a` = agent (there is only one, fixed). `b1`, `b2`, … =
hypermedia sites. Each `b*` is self-contained (`model.ts` / `render.ts` /
`server.ts` / `check.ts`) and does not import from any other instance. `a` never
imports from any `b*` — it only reads their returned HTML. This separation *is*
the thesis setup: the same agent generalizes across sites by adding a parser, not
site knowledge.

## Scripts

```
pnpm install        # once, from this folder
pnpm b1:dev         # run B1 dev server  → http://localhost:3000
pnpm b1:check       # B1 HTTP self-check (site invariants I1–I6)
pnpm b1:mcp         # B1's MCP server over stdio  (B1_MCP_DYNAMIC=1 for the dynamic tool list)
pnpm a:run --goal "Book a table for 2 at 19:00 for Ada Lovelace"   # drive B1 with agent A
pnpm a:check        # A engine self-check (A1–A5, R1–R3; needs a running B1)
pnpm typecheck      # type-check the whole prototype/
```

### Experiment

```
pnpm exp:run --backend random --repeats 1          # the floor, no model needed
pnpm exp:run --backend openai --model qwen3.5:9b   # a local model via Ollama
pnpm exp:run --conditions J+,X --tasks T1          # one cell, one task class
pnpm exp:report                                    # the tables
pnpm exp:check-judges    # declarative vs behavioural oracle agree
pnpm exp:check-mcp       # M1–M3: the MCP conditions are what they claim to be
pnpm exp:elicitation     # model-free interface-side scan over the state space
pnpm exp:figures         # the three-pane figures
```

Six conditions, each neighbouring pair differing in one property — `P` raw page,
`J` static catalogue, `J+` catalogue with preconditions, `X` MCP with a static
tool list, `X+` MCP with a state-filtered one, `H` server-rendered controls. The
design and the reasoning behind each cell are in
`research-notes/exp-conditions-v2.md`; `exp/surface.ts` is the code that
implements it.

New instances follow the same pattern: add `b2/…`, then `"b2:dev"` /
`"b2:check"` scripts and a `b2/**/*.ts` entry (already covered by the tsconfig
include glob).

## Status

- `b1/` — done and verified (see `b1/README.md`). 52748 site invariants pass.
- `a/` — built and verified: native/htmx parsers, discovery, HTTP replay,
  rendering, and a pluggable chooser with three decision modes (index selection,
  native tool call, free construction). 6747 checks pass. See `a/README.md`.
- `exp/` — six conditions wired end to end; 1966 MCP checks and 1239/1239 cells
  of oracle cross-validation pass. **No data collected yet** — the logs were
  cleared when the condition set changed, and the runs in
  `research-notes/exp-conditions-v2.md` §5 have not been done.
- `b2/` — not started. Cross-site generalisation has nothing behind it yet.
