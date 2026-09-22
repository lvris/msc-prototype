/**
 * surface.ts — the ONE thing that differs between experimental conditions.
 *
 * Every condition runs the same loop, the same model, the same prompt scaffold
 * and the same HTTP execution. Only the shape of the action information changes.
 *
 * Four properties separate the six conditions, and each pair of neighbours
 * isolates exactly one of them:
 *
 *                              declared   filtered by   values bound   real tool
 *                              action set   the state   to the control  protocol
 *   P   raw page                  —  (free construction)     —             —
 *   J   catalogue                 yes         no             no            no
 *   J+  catalogue + preconditions yes         no             no            no
 *   X   MCP, static tool list     yes         no             no           YES
 *   X+  MCP, dynamic tool list    yes        YES             no           YES
 *   H   rendered controls         yes        YES            YES            no
 *
 *   P → J   is the action space handed over, or must it be inferred from the page?
 *   J → J+  does stating each precondition in prose compensate for a list that
 *           cannot narrow itself?
 *   J+ → X  ONLY THE PROTOCOL CHANGES. Same operations, same descriptions, same
 *           parameters — but served by a real MCP server over a real transport,
 *           and invoked by native tool calls rather than by picking an index.
 *           This is the cell that answers "your MCP baseline is not MCP".
 *   X → X+  ONLY THE FILTERING CHANGES. The server narrows `tools/list` to the
 *           operations legal right now and emits `notifications/tools/list_changed`.
 *           This is state-dependence, measured inside the real protocol, and it
 *           is the thesis's central quantity.
 *   X+ → H  does binding each value into the control that consumes it remove the
 *           remaining errors — the ones where the action was right and the value
 *           was wrong?
 *   H vs P  both read the same bytes. H is confined to the controls declared in
 *           them; P may construct any request it likes. Declared vs inferred.
 *
 * WHY X AND X+ ARE BOTH HERE. MCP does specify `tools/list_changed`, so a server
 * MAY narrow its tool table as state moves — but that notification is a
 * session-level mechanism (a new integration authorised, a plugin loaded), and
 * deployed servers assemble their tool table once. X is therefore MCP as it is
 * actually run, X+ is MCP at the best the specification allows, and running only
 * one of them invites the opposite objection. More decisively: `X → X+` is where
 * state-dependence is isolated. Drop X and the only remaining comparison is
 * `J+ → X+`, which moves the protocol and the filtering together, leaving the
 * thesis's own claim unmeasured.
 *
 * NOTE THAT THE HARNESS NEVER FILTERS ANYTHING. There is no `validIds` in this
 * file. X+'s narrowing is performed by the SERVER, in `b1/mcp.ts`, and this
 * module learns the narrowed set only by calling `tools/list` as any client
 * would. An earlier design filtered a catalogue here in the harness; that made
 * the condition a statement about our code rather than about a protocol.
 *
 * The `CURRENT PAGE:` block is `describe(html)` in ALL conditions, word for
 * word. Withholding the page from the non-hypermedia conditions would confound
 * "closed action set" with "can see the state at all", and the thesis claims the
 * former. For X and X+ this is deliberately generous — a real MCP client has no
 * page and observes state only through tool results — and that steelman belongs
 * in the threats to validity, not in the harness. P additionally receives the raw
 * HTML, which is what makes it the "just give the page to the model" condition
 * rather than a weaker one.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { Affordance, AffordanceField, Method } from "../a/affordance.ts";
import { discover } from "../a/discover.ts";
import { CATALOGUE, type CatalogueEntry, STATIC_DOMAINS } from "../b1/catalogue.ts";
import { McpSession } from "./mcp-client.ts";

export type Condition = "P" | "J" | "J+" | "X" | "X+" | "H";

/** The ladder, in reading order. Reports and the thesis table follow this. */
export const CONDITIONS: Condition[] = ["P", "J", "J+", "X", "X+", "H"];

/** P has no action list at all; the model constructs its own request. */
export const CONSTRUCTS: ReadonlySet<Condition> = new Set<Condition>(["P"]);

/** X and X+ are invoked by native tool calls, not by choosing an index. */
export const TOOLCALL: ReadonlySet<Condition> = new Set<Condition>(["X", "X+"]);

/** X+ is the one whose offered set is narrowed by the server to the legal ones. */
export const SERVER_FILTERED: ReadonlySet<Condition> = new Set<Condition>(["X+", "H"]);

/**
 * A catalogue entry as an Affordance.
 *
 * Params become required fields with no prefilled VALUE — a catalogue knows the
 * parameter names, and for some of them the permitted set, but never the value
 * the current state would have supplied. That is the difference from a rendered
 * control carrying `slot=20:00` in a hidden input, and it is the difference the
 * `X+ → H` comparison is about.
 *
 * Parameters with a fixed domain get it (`STATIC_DOMAINS`). Not giving the
 * catalogue conditions the menu would have been a limitation of our table rather
 * than of catalogues: nothing stops a real one from listing the dishes, so the
 * baseline gets them.
 */
function toAffordance(e: CatalogueEntry, withNote: boolean): Affordance {
  const fields: AffordanceField[] = e.params.map((p) => ({
    name: p,
    type: "text",
    required: true,
    ...(STATIC_DOMAINS[p] ? { options: [...STATIC_DOMAINS[p]] } : {}),
  }));
  return {
    method: e.method as Method,
    url: e.url,
    fields,
    label: withNote && e.note ? `${e.description} ${e.note}` : e.description,
    source: "native",
  };
}

export const catalogueSurface = (withNote: boolean): Affordance[] =>
  CATALOGUE.map((e) => toAffordance(e, withNote));

export interface SurfaceInput {
  html: string;
}

export interface Surface {
  /** the offered set, in the shape the judge, provenance and the random floor speak. */
  affordances: Affordance[];
  /**
   * Verbatim MCP tool definitions, present only under X / X+. This is what is
   * passed to the model's `tools` parameter, and what makes those conditions
   * tool-CALLING rather than a tool table pasted into a prompt.
   */
  tools?: Tool[];
}

/**
 * Holds whatever a condition needs in order to produce a surface, for the
 * lifetime of a run.
 *
 * Only X and X+ need anything: one MCP server process each, spawned once and
 * reused. They are started lazily, so a run that asks only for H never spawns a
 * server, and a machine without the SDK can still run the other four cells.
 */
export class Surfacer {
  private constructor(
    private readonly base: string,
    private readonly mcp: Map<Condition, McpSession>,
  ) {}

  static async open(opts: { base: string; conditions: readonly Condition[] }): Promise<Surfacer> {
    const mcp = new Map<Condition, McpSession>();
    for (const c of opts.conditions) {
      if (!TOOLCALL.has(c)) continue;
      mcp.set(c, await McpSession.start({ dynamic: c === "X+", base: opts.base }));
    }
    return new Surfacer(opts.base, mcp);
  }

  async for(condition: Condition, input: SurfaceInput): Promise<Surface> {
    switch (condition) {
      case "H":
        return { affordances: discover(input.html) };
      case "J":
        return { affordances: catalogueSurface(false) };
      case "J+":
        return { affordances: catalogueSurface(true) };
      case "X":
      case "X+": {
        const session = this.mcp.get(condition);
        if (!session) throw new Error(`no MCP session open for condition ${condition}`);
        // Re-listed at every step. In X this never changes; in X+ it tracks the
        // state, which is what a client does on tools/list_changed. Polling is
        // the same observation at the same moments, without the timing flakiness.
        return session.surface();
      }
      case "P":
        // Nothing to select from. The model is given the representation and must
        // build a request; `episode.ts` takes it from there.
        return { affordances: [] };
    }
  }

  async close(): Promise<void> {
    for (const s of this.mcp.values()) await s.close();
    this.mcp.clear();
  }
}
