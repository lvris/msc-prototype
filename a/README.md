# A — the fixed generic hypermedia agent

The single, site-agnostic agent. It consumes any `b*/` site by reading the HTML it
returns and acting by **HTTP replay** (no browser, no JS execution). It contains
**zero site-specific code** and never imports any `b*`: an affordance is identified
only by what the HTML declares — `(method, url, fields, label)` — never by a
business id or any custom annotation.

## Shape

```
a/
├── affordance.ts   normalized control shape { method, url, fields[], label, source } + dedupe key
├── parse/
│   ├── dom.ts      the small linkedom DOM surface + shared field extraction
│   ├── native.ts   <a href> and <form> (with a real submit) → affordances
│   └── htmx.ts     hx-get/post/put/delete (+ hx-include="closest form") → affordances
├── discover.ts     html → run both parsers, dedupe → the current valid action set
├── replay.ts       affordance + values → equivalent fetch() request; prepareValues()
├── choose.ts       Chooser interface + backends: manual / openai(qwen) / claude(stub)
├── io.ts           one shared CLI readline
├── loop.ts         GET entry → discover → choose → fill required → replay → repeat
├── run.ts          entry point (flags/env → start loop)
└── check.ts        scripted self-check of the engine (discover + replay), no readline
```

## How it works

1. **Discover.** `discover(html)` parses the representation once and runs the
   native + htmx parsers. htmx `hx-*` are self-describing *attributes*, readable
   without running JavaScript; `hx-target`/`hx-swap` are presentation-only and
   ignored. The result is the **closed, server-declared valid set** for this state.
2. **Choose.** `choose.ts` is the only place nondeterminism lives. Because it is
   handed an already-closed set, no backend — a strong model, a local 7B, or a
   human — can express an action the server did not render. The determinism
   guarantee is structural, not a property of the chooser.
3. **Replay.** A builds the exact HTTP request the control describes and sends it
   with `fetch`. It never sends the `HX-Request` header, so B answers on its
   full-page Post/Redirect/Get path; `fetch` follows the 303, so A always reads a
   complete next representation. Field values come from HTML defaults, the goal, or
   a CLI prompt — A never invents a field.

## Run

```
pnpm b1:dev                              # start a site (B1) in another terminal
pnpm a:run --goal "Book a table for 2 at 19:00 for Ada Lovelace"
pnpm a:run --backend manual --goal "..." # human-driven, no model
pnpm a:check                             # scripted engine self-check (needs a running B1)
```

Flags / env: `--base` (`A_BASE`, default `http://localhost:3000`), `--backend`
(`A_BACKEND`, default `openai`), `--goal` (`A_GOAL`).

### Model backend (auto-drive)

The `openai` backend calls an OpenAI-compatible `/chat/completions` endpoint —
by default a local **qwen** via Ollama:

```
A_MODEL_BASEURL   default http://localhost:11434/v1
A_MODEL           default qwen2.5:7b
A_MODEL_KEY       default "ollama"
```

Start Ollama and pull the model first (`ollama serve`, `ollama pull qwen2.5:7b`).
If the model output is not parseable after one reprompt, A falls back to the manual
chooser for that step. The `claude` backend (`@anthropic-ai/sdk`,
`claude-opus-4-8`) is a stub for a later version.
