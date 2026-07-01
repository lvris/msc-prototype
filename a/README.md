# A — the fixed generic hypermedia agent (planned)

Not built yet. This folder is the single, site-agnostic agent that consumes any
`b*/` site by reading its returned HTML and acting via HTTP replay (no browser,
no JS execution). It contains **zero site-specific code**.

## Planned shape

```
a/
├── parse/
│   ├── native.ts   # <a href>, <form action method> + inputs
│   └── htmx.ts      # hx-get/post/put/delete, hx-include, hx-vals, hx-target/swap
├── normalize.ts     # the shared affordance shape { id, method, url, fields, target? }
├── agent.ts         # discovery loop: GET entry → parse → match intent → replay → GET next
└── run.ts           # entry point (points the agent at a b*/ base URL)
```

- **Pluggable parsers, one per self-describing vocabulary.** Each parser turns a
  representation into normalized affordances. `native` handles the standardized
  core; `htmx` handles the modern extension. A future `b2` in another vocabulary
  = one more parser, same agent.
- **Discovery loop:** cold-start from an entry URL, parse the current state +
  valid affordances, match the user's intent to one of them, send the equivalent
  HTTP request, read the next representation. Rule-based first; LLM intent layer
  (`@anthropic-ai/sdk`, `claude-opus-4-8`) later.
- The `extract()` helper in `b1/check.ts` is the throwaway seed of `parse/`.

See the plan file `~/.claude/plans/demo-crystalline-starfish.md` for the fuller
design rationale.
