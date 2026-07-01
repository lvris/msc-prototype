/**
 * run.ts — entry point. Point A at a b-site base URL with a natural-language goal.
 *
 *   pnpm a:run --goal "Book a table for 2 at 19:00 for Ada Lovelace"
 *   pnpm a:run --backend manual --goal "..."        # human-driven, no model
 *   A_MODEL=qwen2.5:7b pnpm a:run --goal "..."       # pick the local model
 *
 * Defaults: base http://localhost:3000 (B1), backend openai (local qwen via
 * Ollama). The backend is the only site-agnostic knob; A has no B-specific code.
 */

import { makeChooser } from "./choose.ts";
import { run } from "./loop.ts";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const base = arg("--base", process.env.A_BASE ?? "http://localhost:3000");
const backend = arg("--backend", process.env.A_BACKEND ?? "openai");
const goal = arg("--goal", process.env.A_GOAL ?? "");

if (!goal) {
  console.error('missing goal. e.g. pnpm a:run --goal "Book a table for 2 at 19:00 for Ada Lovelace"');
  process.exit(1);
}

await run({ base, goal, chooser: makeChooser(backend) });
