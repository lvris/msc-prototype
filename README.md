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
└── b2/                   a second site in a different vocabulary/framework — future
```

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
pnpm b1:check       # B1 HTTP self-check (3 flows + refusal assertions)
pnpm a:run --goal "Book a table for 2 at 19:00 for Ada Lovelace"   # drive B1 with agent A
pnpm a:check        # A engine self-check (discover + replay; needs a running B1)
pnpm typecheck      # type-check the whole prototype/
```

New instances follow the same pattern: add `b2/…`, then `"b2:dev"` /
`"b2:check"` scripts and a `b2/**/*.ts` entry (already covered by the tsconfig
include glob).

## Status

- `b1/` — done and verified (see `b1/README.md`).
- `a/` — built and verified: native/htmx parsers, discovery, HTTP replay, and a
  pluggable chooser (manual + local-qwen; Claude stubbed). See `a/README.md`.
