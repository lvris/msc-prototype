/**
 * choose.ts — the ONLY place nondeterminism lives, behind one interface.
 *
 * `choose` receives the goal and the already-closed, server-declared valid action
 * set, and returns which one to take. Because the set is closed, no backend —
 * strong model, weak 7B model, or a human — can express an action the server did
 * not render. The determinism guarantee is therefore structural, not a property of
 * the chooser. Backends: `manual` (human picks), `openai` (OpenAI-compatible
 * endpoint, e.g. a local qwen via Ollama), `claude` (deferred).
 */

import type { Affordance } from "./affordance.ts";
import { ask } from "./io.ts";

export interface ChooseContext {
  goal: string;
  step: number;
  /** human-readable content of the current representation (headings + paragraphs). */
  state: string;
  affordances: Affordance[];
  history: string[];
}

export interface Choice {
  /** index into affordances, or -1 to stop (goal reached / nothing applicable). */
  index: number;
  /** values the chooser could supply for the chosen control's fields. */
  values: Record<string, string>;
}

export interface Chooser {
  name: string;
  choose(ctx: ChooseContext): Promise<Choice>;
}

// ── manual ──────────────────────────────────────────────────────────────────
// The human picks an index; field values are collected uniformly by the loop, so
// manual returns no values.
export function manualChooser(): Chooser {
  return {
    name: "manual",
    async choose(ctx) {
      const answer = (await ask(`  pick action [0-${ctx.affordances.length - 1}, or -1 to stop]: `)).trim();
      const index = Number.parseInt(answer, 10);
      return { index: Number.isNaN(index) ? -1 : index, values: {} };
    },
  };
}

// ── random ──────────────────────────────────────────────────────────────────
// A chooser with no goal comprehension at all: it picks uniformly from whatever
// it is offered. It exists as an experimental floor — the score a backend gets
// from the shape of the offered set alone, before any reasoning is added.
export function randomChooser(seed = 1): Chooser {
  let s = seed >>> 0;
  const next = (): number => {
    // xorshift32 — reproducible across runs without a dependency
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x1_0000_0000;
  };
  return {
    name: "random",
    choose(ctx) {
      return Promise.resolve({ index: Math.floor(next() * ctx.affordances.length), values: {} });
    },
  };
}

// ── openai-compatible (qwen via Ollama / LM Studio, etc.) ─────────────────────
export interface ModelConfig {
  baseUrl: string;
  model: string;
  key: string;
  /**
   * 0 means greedy decoding: the same prompt yields the same token every time.
   * Since the prompt here is a pure function of the state, a whole run is then
   * deterministic — repeating it produces a byte-identical trajectory rather than
   * a second sample. Raise it only when the point is to characterise sampling
   * variance.
   */
  temperature: number;
}

export function modelConfigFromEnv(): ModelConfig {
  return {
    baseUrl: process.env.A_MODEL_BASEURL ?? "http://localhost:11434/v1",
    model: process.env.A_MODEL ?? "qwen2.5:7b",
    key: process.env.A_MODEL_KEY ?? "ollama",
    temperature: Number(process.env.A_MODEL_TEMP ?? "0"),
  };
}

const SYSTEM_PROMPT = [
  "You are a web agent driving a website by choosing among the actions it currently offers.",
  "You are given a goal and a numbered list of AVAILABLE ACTIONS. Each action has a method, a url, and zero or more input fields.",
  "Choose the SINGLE action that best advances the goal right now.",
  "Provide values ONLY for fields whose value you can derive from the goal. Never invent personal data (names, phone numbers) that is not in the goal — leave those out and they will be requested from the user.",
  "If the goal is already achieved, or no available action helps, use index -1.",
  'Respond with ONLY a JSON object: {"index": <number>, "values": {"<fieldName>": "<value>"}}. No prose, no code fences.',
].join("\n");

function renderAffordances(affs: Affordance[]): string {
  return affs
    .map((a, i) => {
      const fields = a.fields
        .map((f) => {
          const bits = [f.type, f.required ? "required" : "optional"];
          if (f.options?.length) bits.push(`one of: ${f.options.join(", ")}`);
          if (f.value !== undefined) bits.push(`current: ${f.value}`);
          return `      - ${f.name} (${bits.join(", ")})`;
        })
        .join("\n");
      return `[${i}] ${a.label} — ${a.method} ${a.url}${fields ? `\n${fields}` : ""}`;
    })
    .join("\n");
}

function renderUser(ctx: ChooseContext): string {
  const page = ctx.state ? `\n\nCURRENT PAGE:\n${ctx.state}` : "";
  const past = ctx.history.length ? `\n\nACTIONS TAKEN SO FAR:\n${ctx.history.map((h) => `- ${h}`).join("\n")}` : "";
  return `GOAL: ${ctx.goal}${page}${past}\n\nAVAILABLE ACTIONS:\n${renderAffordances(ctx.affordances)}`;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function callModel(cfg: ModelConfig, messages: ChatMessage[]): Promise<string> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, temperature: cfg.temperature, messages }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const hint = res.status === 404 ? ` — is model "${cfg.model}" pulled? (\`ollama list\`)` : "";
    throw new Error(`model HTTP ${res.status}${hint}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("model returned no content");
  return content;
}

/**
 * Pull the decision object out of the model's text. Robust to reasoning models
 * that emit `<think>…</think>` preambles and to ```json fences: scan for balanced
 * {…} substrings and return the first that parses and carries an `index` field.
 */
function extractChoiceObject(raw: string): { index?: unknown; values?: unknown } {
  const cleaned = raw.replace(/```json/gi, "```").replace(/```/g, "");
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < cleaned.length; j++) {
      if (cleaned[j] === "{") depth++;
      else if (cleaned[j] === "}" && --depth === 0) {
        try {
          const obj = JSON.parse(cleaned.slice(i, j + 1)) as Record<string, unknown>;
          if (obj && typeof obj === "object" && "index" in obj) return obj;
        } catch {
          /* not this candidate; keep scanning */
        }
        break;
      }
    }
  }
  throw new Error('no JSON object with an "index" field in model output');
}

function parseChoice(raw: string, n: number): Choice {
  const obj = extractChoiceObject(raw);
  const index = Number(obj.index);
  if (!Number.isInteger(index) || index < -1 || index >= n) {
    throw new Error(`index ${String(obj.index)} out of range [-1, ${n - 1}]`);
  }
  const values: Record<string, string> = {};
  if (obj.values && typeof obj.values === "object") {
    for (const [k, v] of Object.entries(obj.values as Record<string, unknown>)) {
      values[k] = String(v);
    }
  }
  return { index, values };
}

export function openaiChooser(cfg: ModelConfig = modelConfigFromEnv()): Chooser {
  return {
    name: `openai(${cfg.model})`,
    async choose(ctx) {
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: renderUser(ctx) },
      ];
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          messages.push({ role: "user", content: 'Return ONLY a single JSON object {"index":..,"values":{..}} and nothing else.' });
        }
        const raw = await callModel(cfg, messages);
        try {
          return parseChoice(raw, ctx.affordances.length);
        } catch (e) {
          lastErr = e;
          messages.push({ role: "assistant", content: raw });
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error("model choose failed");
    },
  };
}

// ── claude (deferred) ─────────────────────────────────────────────────────────
export function claudeChooser(): Chooser {
  return {
    name: "claude",
    choose() {
      return Promise.reject(new Error("claude backend not wired in v1 (use --backend openai|manual)"));
    },
  };
}

export function makeChooser(name: string): Chooser {
  switch (name) {
    case "manual":
      return manualChooser();
    case "random":
      return randomChooser();
    case "claude":
      return claudeChooser();
    case "openai":
    case "qwen":
      return openaiChooser();
    default:
      throw new Error(`unknown backend "${name}" (expected openai | manual | claude)`);
  }
}
