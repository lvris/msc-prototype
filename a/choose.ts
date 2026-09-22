/**
 * choose.ts — the ONLY place nondeterminism lives, behind one interface.
 *
 * `choose` receives the goal and the already-closed, server-declared valid action
 * set, and returns which one to take. Because the set is closed, no backend —
 * strong model, weak 7B model, or a human — can express an action the server did
 * not render. The determinism guarantee is therefore structural, not a property of
 * the chooser. Backends: `manual` (human picks), `openai` (OpenAI-compatible
 * endpoint, e.g. a local qwen via Ollama), `claude` (deferred).
 *
 * THREE MODES LIVE HERE, AND TWO OF THEM EXIST ONLY FOR THE BASELINES.
 *
 *   choose()    pick an index out of an offered list         H, J, J+
 *   callTool()  emit a native tool call against a schema     X, X+
 *   construct() build a request from the page, unaided       P
 *
 * Hosting the baseline modes next to the hypermedia one is deliberate. They all
 * share `askModel()`, so every condition gets the same number of attempts and the
 * same parsing leniency; if the tool-calling path lived in `exp/` it would have to
 * duplicate that machinery, and a difference in retry behaviour would land inside
 * the measured gap. What must not leak into `a/` is knowledge of a SITE, and A4
 * asserts that separately — a protocol is not a site.
 */

import type { Affordance, Method } from "./affordance.ts";
import { ask } from "./io.ts";

/**
 * A tool as the model is offered it: a name, a description and a JSON Schema.
 *
 * Declared structurally rather than imported from the MCP SDK so that `a/` does
 * not depend on one protocol's package. MCP's `Tool` satisfies this shape, and
 * so does a plain OpenAI function definition.
 */
export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** Prompt and completion tokens for one decision, summed over any reprompts. */
export interface Usage {
  prompt: number;
  completion: number;
}

export interface ChooseContext {
  goal: string;
  step: number;
  /** human-readable content of the current representation (headings + paragraphs). */
  state: string;
  affordances: Affordance[];
  history: string[];
  /**
   * The representation itself, verbatim. Supplied only when the caller wants a
   * request CONSTRUCTED rather than selected: with no list to choose from, the
   * page is all the model has to go on. This is the "just give the model the
   * page" condition, and handing over anything less than the real bytes would
   * make it a weaker one than the argument it stands for.
   */
  document?: string;
  /**
   * Tool definitions to offer natively. Supplied only in tool-calling mode; the
   * model receives them through the request's `tools` parameter rather than as
   * text in the prompt, which is the whole difference between X and J+.
   */
  tools?: ToolDef[];
}

export interface Choice {
  /**
   * Index into affordances, or -1 to stop (goal reached / nothing applicable).
   * Ignored when `action` or `toolName` is present.
   */
  index: number;
  /** values the chooser could supply for the chosen control's fields. */
  values: Record<string, string>;
  /**
   * A request the model built for itself, rather than picked from a list. Only
   * ever set in construction mode; the harness turns it into a request exactly as
   * it would a selected control, so the two are judged by the same rule.
   */
  action?: { method: Method; url: string };
  /**
   * The tool the model called, by name. Set only in tool-calling mode. A name
   * that is not in the offered set is passed through UNCHANGED rather than
   * dropped: "the model asked for a tool that does not exist" is the
   * out-of-space error the evaluation counts, and repairing it here would erase
   * the measurement.
   */
  toolName?: string;
  /**
   * The model produced neither a tool call nor the agreed stop token. This is
   * the no-tool-call failure, and it is distinct from abstaining: one is the
   * model declining, the other is the model failing to answer in the protocol.
   */
  noToolCall?: boolean;
  /** tokens spent reaching this decision, when the backend reports them. */
  usage?: Usage;
}

export interface Chooser {
  name: string;
  choose(ctx: ChooseContext): Promise<Choice>;
  /**
   * Build a request from the representation, unconstrained by any offered set.
   * Optional: a backend that cannot do this (the random floor has nothing to
   * construct FROM) simply does not implement it, and the harness reports the
   * cell as unavailable rather than inventing a result for it.
   */
  construct?(ctx: ChooseContext): Promise<Choice>;
  /**
   * Emit a native tool call against `ctx.tools`.
   *
   * Optional for the same reason `construct` is, but the fallback differs: a
   * backend without this (the random floor) is still perfectly able to select
   * from the offered set by index, because the set is the same set. It simply
   * does so without speaking the protocol — which is honest, since a backend
   * that makes no model call has no protocol to speak. The harness falls back to
   * `choose` rather than skipping the cell, and `random × X+` stays available as
   * the cleanest evidence that the constraint rather than the reasoning is doing
   * the work.
   */
  callTool?(ctx: ChooseContext): Promise<Choice>;
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

/**
 * The construction prompt. It is the selection prompt with the list removed and
 * the page put in its place: same role, same goal, same stopping rule, same
 * instruction not to invent personal data. What differs is the only thing meant
 * to differ — whether the action space is handed over or has to be inferred.
 */
const CONSTRUCT_PROMPT = [
  "You are a web agent driving a website. You are given a goal and the current page's HTML.",
  "There is no list of available actions: work out for yourself what request to send next.",
  "Read the page, decide what to do, and emit the HTTP request a browser would send.",
  "Provide values ONLY for parameters you can derive from the goal or from the page. Never invent personal data (names, phone numbers) that is not in the goal — leave those out and they will be requested from the user.",
  "If the goal is already achieved, or nothing on this page helps, use method \"STOP\".",
  'Respond with ONLY a JSON object: {"method": "GET|POST|PUT|DELETE|STOP", "url": "/path", "values": {"<param>": "<value>"}}. No prose, no code fences.',
].join("\n");

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

/** The assistant turn as the endpoint returns it, in the two shapes it can take. */
interface RawMessage {
  content?: string | null;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
}

interface ModelReply {
  message: RawMessage;
  usage: Usage;
}

/**
 * One request to the endpoint.
 *
 * `tools` is passed through only when the caller supplies it, so the selection
 * and construction modes send byte-identical request bodies to what they always
 * did. Usage is read back where the endpoint reports it and zeroed where it does
 * not, because the cost figures have to be summed over conditions that may not
 * all be served by the same backend.
 */
async function callModel(
  cfg: ModelConfig,
  messages: ChatMessage[],
  tools?: ToolDef[],
): Promise<ModelReply> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: cfg.temperature,
      messages,
      ...(tools?.length
        ? {
            tools: tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const hint = res.status === 404 ? ` — is model "${cfg.model}" pulled? (\`ollama list\`)` : "";
    throw new Error(`model HTTP ${res.status}${hint}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: RawMessage }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("model returned no message");
  return {
    message,
    usage: {
      prompt: data.usage?.prompt_tokens ?? 0,
      completion: data.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Pull the decision object out of the model's text. Robust to reasoning models
 * that emit `<think>…</think>` preambles and to ```json fences: scan for balanced
 * {…} substrings and return the first that parses and carries `key`.
 */
function extractObject(raw: string, key: string): Record<string, unknown> {
  const cleaned = raw.replace(/```json/gi, "```").replace(/```/g, "");
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < cleaned.length; j++) {
      if (cleaned[j] === "{") depth++;
      else if (cleaned[j] === "}" && --depth === 0) {
        try {
          const obj = JSON.parse(cleaned.slice(i, j + 1)) as Record<string, unknown>;
          if (obj && typeof obj === "object" && key in obj) return obj;
        } catch {
          /* not this candidate; keep scanning */
        }
        break;
      }
    }
  }
  throw new Error(`no JSON object with a "${key}" field in model output`);
}

function renderConstructUser(ctx: ChooseContext): string {
  const past = ctx.history.length
    ? `\n\nREQUESTS SENT SO FAR:\n${ctx.history.map((h) => `- ${h}`).join("\n")}`
    : "";
  return `GOAL: ${ctx.goal}${past}\n\nCURRENT PAGE (raw HTML):\n${ctx.document ?? ""}`;
}

const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

/**
 * Read a constructed request out of the model's text.
 *
 * A malformed reply is not smoothed over. If the model names no method, or one
 * that is not a verb, the step is a stop rather than a guess — inventing a
 * request the model did not ask for would credit the condition with an action it
 * never produced. Whether it produced a well-formed request at all is part of
 * what P is measuring.
 */
function parseConstruction(raw: string): Choice {
  const obj = extractObject(raw, "method") as { method?: unknown; url?: unknown; values?: unknown };
  const method = String(obj.method ?? "").toUpperCase();
  const url = String(obj.url ?? "").trim();

  const values: Record<string, string> = {};
  if (obj.values && typeof obj.values === "object") {
    for (const [k, v] of Object.entries(obj.values as Record<string, unknown>)) values[k] = String(v);
  }

  if (!METHODS.has(method) || url === "") return { index: -1, values };
  return { index: 0, values, action: { method: method as Method, url } };
}

function parseChoice(raw: string, n: number): Choice {
  const obj = extractObject(raw, "index");
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

/**
 * One call with one reprompt on unparseable output. Shared by ALL THREE modes so
 * the conditions differ in their prompt and protocol and nothing else — not in
 * how many tries they get, nor in how forgivingly their output is read. Tokens
 * are summed across attempts, so a condition that needs reprompting is charged
 * for it.
 */
async function askModel(
  cfg: ModelConfig,
  system: string,
  user: string,
  retry: string,
  parse: (message: RawMessage) => Choice,
  opts: {
    tools?: ToolDef[];
    /**
     * What to return when every attempt failed to parse, instead of throwing.
     *
     * Tool-calling needs this: a reply carrying neither a tool call nor the stop
     * token is a RESULT — the no-tool-call error the benchmark literature counts
     * — and letting it surface as a harness exception would file a measurement
     * under "the run broke". Modes without a meaningful exhausted state simply
     * omit it and keep throwing.
     */
    onExhausted?: (usage: Usage) => Choice;
  } = {},
): Promise<Choice> {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const usage: Usage = { prompt: 0, completion: 0 };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) messages.push({ role: "user", content: retry });
    const reply = await callModel(cfg, messages, opts.tools);
    usage.prompt += reply.usage.prompt;
    usage.completion += reply.usage.completion;
    try {
      return { ...parse(reply.message), usage };
    } catch (e) {
      lastErr = e;
      messages.push({ role: "assistant", content: reply.message.content ?? "" });
    }
  }
  if (opts.onExhausted) return opts.onExhausted(usage);
  throw lastErr instanceof Error ? lastErr : new Error("model call failed");
}

/** The assistant turn's text, however the endpoint chose to represent "empty". */
const textOf = (m: RawMessage): string => m.content ?? "";

/**
 * The tool-calling prompt. It is the selection prompt with the numbered list
 * removed and the native tool mechanism put in its place: same role, same goal,
 * same instruction about values, same stopping rule. What differs is the only
 * thing meant to differ — whether the action space arrives as text to read or as
 * a schema to call.
 *
 * The stop convention mirrors the other two modes. Selection stops with
 * `index: -1`, construction with `method: "STOP"`, and tool-calling by declining
 * to call and saying so. Without an explicit token there would be no way to
 * separate "I am done" from "I failed to produce a call", and those are
 * different results.
 */
const TOOL_PROMPT = [
  "You are a web agent driving a website by calling the tools it currently offers.",
  "You are given a goal and the current page. Call the SINGLE tool that best advances the goal right now.",
  "Provide values ONLY for arguments you can derive from the goal. Never invent personal data (names, phone numbers) that is not in the goal — leave those out and they will be requested from the user.",
  "If the goal is already achieved, or no available tool helps, do NOT call a tool: reply with the single word STOP.",
].join("\n");

function renderToolUser(ctx: ChooseContext): string {
  const page = ctx.state ? `\n\nCURRENT PAGE:\n${ctx.state}` : "";
  const past = ctx.history.length
    ? `\n\nACTIONS TAKEN SO FAR:\n${ctx.history.map((h) => `- ${h}`).join("\n")}`
    : "";
  return `GOAL: ${ctx.goal}${page}${past}`;
}

/**
 * Read a tool call out of the assistant turn.
 *
 * The tool NAME is passed through exactly as the model emitted it, including
 * names that are not on offer. A hallucinated tool is the out-of-space error the
 * evaluation counts; mapping it to the nearest real one, or dropping the step,
 * would delete the measurement.
 *
 * Unparseable arguments are not fatal. The model named an action, and that fact
 * is worth recording even when the JSON around it is malformed — the step then
 * proceeds with no values and fails on the value side, which is exactly what it
 * is.
 */
function parseToolCall(message: RawMessage): Choice {
  const call = message.tool_calls?.[0];
  if (call?.function?.name) {
    const values: Record<string, string> = {};
    try {
      const args = JSON.parse(call.function.arguments ?? "{}") as Record<string, unknown>;
      if (args && typeof args === "object") {
        for (const [k, v] of Object.entries(args)) values[k] = String(v);
      }
    } catch {
      /* named an action but mangled its arguments; recorded as a valueless call */
    }
    // `index` is ignored whenever `toolName` is set; the harness resolves the
    // name against the offered set, because only it knows what was offered.
    return { index: 0, values, toolName: call.function.name };
  }

  if (/\bSTOP\b/i.test(textOf(message))) return { index: -1, values: {} };
  throw new Error("reply carried neither a tool call nor STOP");
}

export function openaiChooser(cfg: ModelConfig = modelConfigFromEnv()): Chooser {
  return {
    name: `openai(${cfg.model})`,
    choose(ctx) {
      return askModel(
        cfg,
        SYSTEM_PROMPT,
        renderUser(ctx),
        'Return ONLY a single JSON object {"index":..,"values":{..}} and nothing else.',
        (m) => parseChoice(textOf(m), ctx.affordances.length),
      );
    },
    construct(ctx) {
      return askModel(
        cfg,
        CONSTRUCT_PROMPT,
        renderConstructUser(ctx),
        'Return ONLY a single JSON object {"method":..,"url":..,"values":{..}} and nothing else.',
        (m) => parseConstruction(textOf(m)),
      );
    },
    callTool(ctx) {
      return askModel(
        cfg,
        TOOL_PROMPT,
        renderToolUser(ctx),
        "Call exactly one of the available tools, or reply with the single word STOP.",
        parseToolCall,
        {
          tools: ctx.tools ?? [],
          // Two attempts produced no call and no stop token. That is the
          // no-tool-call result, not a broken run.
          onExhausted: (usage) => ({ index: -1, values: {}, noToolCall: true, usage }),
        },
      );
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
