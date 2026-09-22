/**
 * mcp-client.ts — the harness's MCP client.
 *
 * Conditions X and X+ get their action information from a real MCP server
 * (`b1/mcp.ts`) over a real stdio transport: this module spawns it, performs
 * `tools/list`, and hands the result to the experiment in two shapes at once.
 *
 *   `tools`        the JSON-Schema tool definitions, passed verbatim to the
 *                  model's `tools` parameter. This is what makes X and X+ tool
 *                  CALLING conditions rather than a tool table pasted into a
 *                  prompt.
 *
 *   `affordances`  the same tools normalised to `Affordance`, which is what the
 *                  judge, the provenance classifier and the random backend all
 *                  speak. Nothing about the measurement machinery then needs to
 *                  know that this condition arrived over JSON-RPC.
 *
 * The second shape is also what keeps the `random` floor available under X/X+:
 * a backend that makes no model call has no protocol to speak, so it selects
 * from the offered set by index, exactly as it does under H. Whatever it scores
 * is scored by the constraint rather than by reasoning, which is the point of
 * having it.
 *
 * WHAT THIS MODULE MAY NOT DO. It never reads `GET /__session`. The filtering
 * in X+ is performed by the SERVER, and the client learns the narrowed set only
 * by asking `tools/list` like any other client would. If the harness peeked at
 * the session here, X+ would be measuring the harness rather than the protocol.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Affordance, AffordanceField, Method } from "../a/affordance.ts";
import { entryFor } from "../b1/catalogue.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "b1", "mcp.ts");

export interface McpSurface {
  /** verbatim tool definitions for the model's `tools` parameter. */
  tools: Tool[];
  /** the same set as the harness's normalised control shape. */
  affordances: Affordance[];
}

/**
 * An MCP tool as an Affordance.
 *
 * The (method, url) pair is not in the tool definition — a tool is named, not
 * addressed, which is precisely what distinguishes a tool contract from a
 * hypermedia control. The harness recovers it from the catalogue so that
 * execution and judging can be uniform across conditions; the MODEL never sees
 * it, and never needs to.
 */
export function toAffordance(t: Tool): Affordance {
  const entry = entryFor(t.name);
  const props = (t.inputSchema?.properties ?? {}) as Record<string, { enum?: unknown }>;
  const required = new Set((t.inputSchema?.required ?? []) as string[]);
  const fields: AffordanceField[] = Object.entries(props).map(([name, schema]) => {
    // A schema `enum` is the same statement a `<select>`'s options are: these and
    // no others. Carrying it across means the provenance classifier sees a bounded
    // field rather than an open one, and the value-side figures compare like with
    // like instead of crediting hypermedia for a distinction the schema also made.
    const permitted = Array.isArray(schema?.enum) ? schema.enum.map(String) : undefined;
    return {
      name,
      type: "text",
      required: required.has(name),
      ...(permitted ? { options: permitted } : {}),
    };
  });
  return {
    method: (entry?.method ?? "POST") as Method,
    url: entry?.url ?? `/${t.name}`,
    fields,
    label: t.description ?? t.name,
    source: "native",
  };
}

export class McpSession {
  private constructor(
    private readonly client: Client,
    readonly dynamic: boolean,
  ) {}

  /**
   * Spawn `b1/mcp.ts` and connect. One session is reused for a whole run: the
   * server is stateless with respect to the booking (it reads the site over
   * HTTP), so restarting it per episode would buy nothing but latency.
   */
  static async start(opts: { dynamic: boolean; base?: string }): Promise<McpSession> {
    const client = new Client({ name: "hypermedia-thesis-harness", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", SERVER],
      env: {
        ...(process.env as Record<string, string>),
        ...(opts.dynamic ? { B1_MCP_DYNAMIC: "1" } : { B1_MCP_DYNAMIC: "0" }),
        ...(opts.base ? { B1_BASE: opts.base } : {}),
      },
      stderr: "ignore",
    });
    await client.connect(transport);
    return new McpSession(client, opts.dynamic);
  }

  /**
   * The tools offered right now.
   *
   * Called fresh at every step. In static mode the answer never changes; in
   * dynamic mode it tracks the state, and re-listing is what a client does on
   * `notifications/tools/list_changed`. Polling rather than subscribing is the
   * same observation taken at the same moments, and it removes a source of
   * timing flakiness from the measurement.
   */
  async surface(): Promise<McpSurface> {
    const { tools } = await this.client.listTools();
    return { tools, affordances: tools.map(toAffordance) };
  }

  /** Execute through the protocol. Used by `check-mcp.ts` (M1), not by episodes. */
  async call(name: string, args: Record<string, string>): Promise<{ isError: boolean; text: string }> {
    const res = await this.client.callTool({ name, arguments: args });
    const text = Array.isArray(res.content)
      ? res.content.map((c) => (c.type === "text" ? c.text : "")).join("")
      : "";
    return { isError: res.isError === true, text };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
