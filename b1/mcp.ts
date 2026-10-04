/**
 * mcp.ts — B1's Model Context Protocol server.
 *
 * This is the site's machine-facing contract, and it exists so that the MCP
 * conditions in the evaluation are run against a REAL MCP server rather than
 * against our impression of one. It speaks JSON-RPC over stdio, answers
 * `tools/list` and `tools/call`, and is usable by any MCP client.
 *
 * It runs in two modes, and the difference between them is one of the
 * experiment's manipulated variables:
 *
 *   STATIC   (default)            `tools/list` returns all 21 catalogued
 *                                 operations, whatever the session is doing.
 *                                 This is how MCP servers are actually
 *                                 deployed: the tool table is assembled once,
 *                                 and clients cache it for the session.
 *
 *   DYNAMIC  (B1_MCP_DYNAMIC=1)   `tools/list` returns only the operations the
 *                                 site holds legal in the CURRENT state, and
 *                                 the server declares `tools.listChanged` and
 *                                 actually emits the notification after any
 *                                 call that moved the state. This is MCP at the
 *                                 best the specification allows.
 *
 * WHERE THIS SITS. It is part of the SITE, not part of the agent. It is
 * therefore allowed to know the site's state — it reads `GET /__session` for
 * the same reason `render.ts` calls `validAffordances()`: a server knowing what
 * it will currently accept is the premise, not the conclusion. What must not
 * happen is the AGENT knowing it, and `a/check.ts` asserts that separately.
 *
 * WHY THE TOOLS ARE GENERATED, NOT WRITTEN. Every tool is derived from
 * `catalogue.ts` — the same table the J/J+ conditions are built from. Hand-
 * writing the schemas would let the MCP condition drift into carrying more (or
 * less) information than the catalogue conditions, and the comparison
 * `J+ → X` is supposed to isolate the PROTOCOL and nothing else. Generation
 * makes that an implementation property instead of a promise; `exp/check-mcp.ts`
 * asserts it.
 *
 * NOTE ON EXECUTION. `tools/call` here is complete and works. The experiment
 * nevertheless routes every condition's execution through one HTTP path in
 * `exp/episode.ts`, so that status codes, provenance and judging are byte-for-
 * byte identical across conditions. `exp/check-mcp.ts` (M1) asserts the two
 * paths agree, which is what licenses that shortcut.
 *
 *   node --import tsx b1/mcp.ts                  # static
 *   B1_MCP_DYNAMIC=1 node --import tsx b1/mcp.ts # dynamic
 */

import { pathToFileURL } from "node:url";

/**
 * The LOW-LEVEL protocol server, not the `McpServer` convenience wrapper.
 *
 * The SDK marks `Server` deprecated "for the high-level API… only use `Server`
 * for advanced use cases", and this is one of them, for two reasons that both
 * matter to the experiment:
 *
 *   1. the tool list must be computed WHEN `tools/list` ARRIVES, from state
 *      that lives in another process. `McpServer.registerTool` fixes the set at
 *      registration and offers only `enable()`/`disable()` after the fact,
 *      which cannot be driven per request without racing the client.
 *   2. the schemas must be the raw JSON Schema generated from `catalogue.ts`.
 *      `registerTool` takes zod and converts, which would let the MCP condition
 *      carry a differently-shaped schema than the catalogue conditions and quietly
 *      break the `J+ → X` comparison.
 *
 * `Server` is the protocol implementation itself — `McpServer` is sugar over it
 * — so nothing about compliance is given up here.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { CATALOGUE, type CatalogueEntry, STATIC_DOMAINS } from "./catalogue.ts";
import { freeSlots, type ActionId, type Session } from "./model.ts";

const BASE = process.env.B1_BASE ?? "http://localhost:3000";
const DYNAMIC = process.env.B1_MCP_DYNAMIC === "1";

/**
 * A catalogue entry as an MCP tool.
 *
 * The description carries `note` — the precondition in prose — in BOTH modes.
 * The static mode needs it because a list that cannot narrow itself has nowhere
 * else to put the information; the dynamic mode keeps it so that `X → X+`
 * differs in exactly one thing, the filtering. An earlier design dropped the
 * note when filtering was switched on, which moved two variables at once.
 *
 * Every parameter is a required string, mirroring `exp/surface.ts`'s treatment
 * of the same catalogue: a catalogue knows parameter NAMES, never the values
 * the current state would have given them.
 */
export function toolFor(e: CatalogueEntry, domains: Domains = {}): Tool {
  return {
    name: e.id,
    description: e.note ? `${e.description} ${e.note}` : e.description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        e.params.map((p) => {
          const permitted = domains[p] ?? STATIC_DOMAINS[p];
          return [
            p,
            {
              type: "string",
              description: `The ${p} to use.`,
              ...(permitted ? { enum: [...permitted] } : {}),
            },
          ];
        }),
      ),
      required: e.params,
      additionalProperties: false,
    },
  };
}

/**
 * Permitted values to publish in the schema beyond the fixed ones.
 *
 * Empty in static mode, so X advertises exactly the domains a fixed table can
 * know: the menu and the bookable dates. The dynamic mode adds the ones that
 * depend on the session, which is the only thing a contract able to re-issue its
 * schema can do that a fixed one cannot.
 *
 * This is the baseline being steelmanned on purpose. JSON Schema has `enum`, MCP
 * servers use it, and a tool for "hold a slot" written by someone with access to
 * the session would list the free slots. Emitting `{"type":"string"}` instead
 * would have manufactured a value-side failure out of our own schema generator
 * and then attributed it to the protocol.
 */
type Domains = Readonly<Record<string, readonly string[]>>;

const dynamicDomains = (session: Session): Domains => ({ slot: freeSlots(session) });

interface SessionSnapshot {
  session: Session;
  valid: { id: ActionId }[];
}

async function snapshot(): Promise<SessionSnapshot> {
  const r = await fetch(`${BASE}/__session`);
  if (!r.ok) throw new Error(`b1 not reachable at ${BASE} (HTTP ${r.status})`);
  return (await r.json()) as SessionSnapshot;
}

/**
 * The tools this server offers right now.
 *
 * Static mode: every catalogued operation, with the fixed domains. Dynamic mode:
 * only the operations legal in this state, with the state's domains as well.
 * Both halves of that difference are things `tools/list_changed` exists to allow,
 * and X+ is what MCP looks like when a server uses it to the full.
 */
export async function currentTools(): Promise<Tool[]> {
  if (!DYNAMIC) return CATALOGUE.map((e) => toolFor(e));
  const { session, valid } = await snapshot();
  const legal = new Set(valid.map((v) => v.id));
  const domains = dynamicDomains(session);
  return CATALOGUE.filter((e) => legal.has(e.id)).map((e) => toolFor(e, domains));
}

/**
 * Perform the operation against the running site.
 *
 * Values arrive as whatever the model produced. They are passed through
 * unaltered — coercing or repairing them here would hide exactly the failure
 * (`right action, wrong value`) the evaluation is trying to count.
 */
async function perform(
  e: CatalogueEntry,
  args: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) values[k] = String(v);

  const target = new URL(e.url, BASE);
  let res: Response;
  if (e.method === "GET") {
    for (const [k, v] of Object.entries(values)) target.searchParams.set(k, v);
    res = await fetch(target, { redirect: "follow" });
  } else {
    res = await fetch(target, {
      method: e.method,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values).toString(),
      redirect: "follow",
    });
  }
  return { status: res.status, body: await res.text() };
}

const server = new Server(
  { name: "b1-restaurant-booking", version: "1.0.0" },
  {
    capabilities: {
      // Declared only in dynamic mode, and only because the notification is
      // genuinely sent below. Declaring a capability the server never exercises
      // would misrepresent the baseline in the direction that flatters it.
      tools: DYNAMIC ? { listChanged: true } : {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: await currentTools(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const entry = CATALOGUE.find((e) => e.id === name);

  // A name that is not in the catalogue. Reported as a tool error rather than a
  // protocol error, because "the model asked for something that does not exist"
  // is a measurement, not a transport failure.
  if (!entry) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `No such tool: ${name}` }],
    };
  }

  const { status, body } = await perform(entry, (args ?? {}) as Record<string, unknown>);
  const ok = status < 400;

  // The state may have moved, so a dynamic server tells its client the tool
  // table is stale. Our own client re-lists every step regardless, but a server
  // that declares listChanged and stays silent is not one.
  if (DYNAMIC && ok) await server.sendToolListChanged().catch(() => {});

  return {
    isError: !ok,
    content: [
      {
        type: "text" as const,
        text: `HTTP ${status}${ok ? "" : status === 409 ? " — refused in the current state" : " — rejected"}\n\n${body.slice(0, 4000)}`,
      },
    ],
  };
});

// Only start a transport when run as a program. `exp/check-mcp.ts` imports
// `toolFor` / `currentTools` and must not spawn a stdio server by doing so.
// `pathToFileURL` rather than string concatenation: on Windows argv[1] is
// `D:\...` and import.meta.url is `file:///D:/...`, which no hand-built prefix
// gets right.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await server.connect(new StdioServerTransport());
  process.stderr.write(`b1 mcp server up — mode=${DYNAMIC ? "dynamic" : "static"} base=${BASE}\n`);
}

export { server, DYNAMIC, BASE };
