/**
 * check-mcp.ts — the three claims the MCP conditions rest on.
 *
 * X and X+ are meant to be read as "MCP as it is deployed" and "MCP at the best
 * its specification allows". Three things have to be true for those readings to
 * hold, and none of them is self-evident:
 *
 *   M1  `tools/call` and direct HTTP are the same action. The experiment routes
 *       every condition's execution through one HTTP path so that status codes,
 *       provenance and judging are identical across conditions — but that is
 *       only legitimate if the protocol path would have done the same thing.
 *       Without M1, "we ran a real MCP server" is undercut by "and then we
 *       didn't use it".
 *
 *   M2  X+'s `tools/list` is exactly `validAffordances(s)`, in both directions,
 *       across the reachable state space. This is what makes X+ the dynamic
 *       condition rather than an approximation of one. One direction alone would
 *       not do: a list that omits a legal operation and a list that offers an
 *       illegal one are different failures, and the claim excludes both.
 *
 *   M3  X carries the same information as J+. The `J+ -> X` cell is supposed to
 *       isolate the PROTOCOL; if the tool descriptions said more (or less) than
 *       the catalogue labels, that cell would be measuring a content difference
 *       wearing a protocol's clothes. Generation from one table is the mechanism;
 *       this is the assertion that the mechanism worked.
 *
 * Usage:  pnpm exp:check-mcp [--states N | --states all]
 */

import { CATALOGUE, SAMPLE_VALUES } from "../b1/catalogue.ts";
import { BASE, explore, startSite, stateKey } from "../b1/explore.ts";
import { freeSlots } from "../b1/model.ts";
import { resetTo, snapshot } from "./judge.ts";
import { McpSession } from "./mcp-client.ts";
import { catalogueSurface } from "./surface.ts";

const failures: string[] = [];
let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) passed++;
  else {
    console.log(`  ✗ ${msg}`);
    failures.push(msg);
  }
}
const section = (title: string): void => console.log(`\n# ${title}`);

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

await startSite();

const asked = arg("--states", "40");
const graph = await explore();
const all = [...graph.nodes.values()];
// Stride-sample rather than take a prefix: the walk is breadth-first, so the
// first N states are all near the entry point and the gated ones — which are
// the whole point — would never be reached.
const stride = asked === "all" ? 1 : Math.max(1, Math.ceil(all.length / Number(asked)));
const sample = all.filter((_, i) => i % stride === 0);

console.log(
  `b1 has ${all.length} reachable states; probing ${sample.length} (stride ${stride})` +
    ` × ${CATALOGUE.length} actions for M1 = ${sample.length * CATALOGUE.length * 2} calls`,
);

const statik = await McpSession.start({ dynamic: false, base: BASE });
const dyn = await McpSession.start({ dynamic: true, base: BASE });

// ── M3 — X says exactly what J+ says ────────────────────────────────────────

section("M3 — X's tool descriptions carry the same information as J+'s labels");

{
  const tools = (await statik.surface()).tools ?? [];
  assert(tools.length === CATALOGUE.length, `M3 X offers all ${CATALOGUE.length} catalogued operations (got ${tools.length})`);

  const jplus = new Set(catalogueSurface(true).map((a) => a.label));
  const x = new Set(tools.map((t) => t.description ?? ""));
  for (const label of jplus) assert(x.has(label), `M3 J+ label present in X: "${label.slice(0, 60)}…"`);
  for (const d of x) assert(jplus.has(d), `M3 X description present in J+: "${d.slice(0, 60)}…"`);

  // The parameters must match too — names AND permitted values. A tool that
  // quietly took an extra argument, or that published a domain the catalogue
  // withheld, would be a different offer wearing the same description, and
  // `J+ → X` would stop isolating the protocol.
  const jplusFields = new Map(
    catalogueSurface(true).map((a) => [`${a.method} ${a.url}`, a.fields]),
  );
  for (const t of tools) {
    const entry = CATALOGUE.find((e) => e.id === t.name);
    const props = (t.inputSchema?.properties ?? {}) as Record<string, { enum?: unknown }>;
    assert(
      entry !== undefined && JSON.stringify(Object.keys(props).sort()) === JSON.stringify([...entry.params].sort()),
      `M3 ${t.name} declares exactly the catalogue's parameters`,
    );
    if (!entry) continue;

    const mine = jplusFields.get(`${entry.method} ${entry.url}`) ?? [];
    for (const [name, schema] of Object.entries(props)) {
      const x = Array.isArray(schema?.enum) ? schema.enum.map(String).sort() : null;
      const j = mine.find((f) => f.name === name)?.options?.slice().sort() ?? null;
      assert(
        JSON.stringify(x) === JSON.stringify(j),
        `M3 ${t.name}.${name} permitted values match J+ (X: ${JSON.stringify(x)}, J+: ${JSON.stringify(j)})`,
      );
    }
  }
}

// ── M4 — X+ publishes the domains only a stateful contract could know ───────

section("M4 — X+ enumerates the state's own values, X cannot");

{
  await resetTo(BASE, { status: "browsing", date: "next-week", partySize: 2 });
  const slotEnum = (tools: readonly { name: string; inputSchema?: { properties?: unknown } }[]): string[] | null => {
    const hold = tools.find((t) => t.name === "hold_slot");
    const p = (hold?.inputSchema?.properties ?? {}) as Record<string, { enum?: unknown }>;
    return Array.isArray(p.slot?.enum) ? p.slot.enum.map(String).sort() : null;
  };

  const truth = freeSlots((await snapshot(BASE)).session).slice().sort();
  const dyn_ = slotEnum((await dyn.surface()).tools ?? []);
  const stat_ = slotEnum((await statik.surface()).tools ?? []);

  assert(
    stat_ === null,
    `M4 X leaves slot unenumerated — a fixed table cannot know it (got ${JSON.stringify(stat_)})`,
  );
  assert(
    JSON.stringify(dyn_) === JSON.stringify(truth),
    `M4 X+ enumerates exactly the free slots (X+: ${JSON.stringify(dyn_)}, truth: ${JSON.stringify(truth)})`,
  );
}

// ── M2 — X+ offers exactly what the state allows ────────────────────────────

section("M2 — X+'s tools/list == validAffordances(s), both directions");

for (const node of sample) {
  await resetTo(BASE, node.session as unknown as Record<string, unknown>);
  const truth = new Set<string>((await snapshot(BASE)).validIds);
  const listed = new Set(((await dyn.surface()).tools ?? []).map((t) => t.name));

  for (const id of truth) assert(listed.has(id), `M2 ${node.key}: legal ${id} is offered`);
  for (const name of listed) assert(truth.has(name), `M2 ${node.key}: offered ${name} is legal`);
}

// ── M1 — tools/call and direct HTTP are the same action ─────────────────────

section("M1 — tools/call agrees with direct HTTP (outcome and state transition)");

/** The same request the harness's `exec()` would send. */
async function directly(
  id: string,
  values: Record<string, string>,
): Promise<{ ok: boolean; status: number }> {
  const e = CATALOGUE.find((c) => c.id === id)!;
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
  return { ok: res.status < 400, status: res.status };
}

const valuesFor = (id: string): Record<string, string> =>
  Object.fromEntries(
    CATALOGUE.find((c) => c.id === id)!.params.map((p) => [p, SAMPLE_VALUES[p] ?? "x"]),
  );

/**
 * Every catalogued operation is fired from every sampled state, twice: once
 * through the protocol and once over HTTP, each from the same starting state.
 * Both the outcome and the state it leaves behind must agree — agreement on the
 * status code alone would miss a call that reported success without moving
 * anything.
 */
for (const node of sample) {
  const start = node.session as unknown as Record<string, unknown>;
  for (const entry of CATALOGUE) {
    const values = valuesFor(entry.id);

    await resetTo(BASE, start);
    const viaMcp = await dyn.call(entry.id, values);
    const afterMcp = stateKey((await snapshot(BASE)).session);

    await resetTo(BASE, start);
    const viaHttp = await directly(entry.id, values);
    const afterHttp = stateKey((await snapshot(BASE)).session);

    assert(
      viaMcp.isError === !viaHttp.ok,
      `M1 ${node.key} ${entry.id}: outcome agrees (mcp isError=${viaMcp.isError}, http ${viaHttp.status})`,
    );
    assert(
      afterMcp === afterHttp,
      `M1 ${node.key} ${entry.id}: same resulting state (${afterMcp} vs ${afterHttp})`,
    );
  }
}

// ── an unoffered name is refused, not resolved ──────────────────────────────

section("M1b — a tool that does not exist is reported as an error");

{
  const r = await dyn.call("obliterate_restaurant", {});
  assert(r.isError, "M1b calling an unknown tool is an error");
  assert(/no such tool/i.test(r.text), "M1b … and says so rather than doing something else");
}

// ── M1c — a real tool that tools/list did not offer ─────────────────────────

/**
 * The case the headline finding is made of, and the one the harness got wrong
 * first time round.
 *
 * Under X+ a weaker model sometimes calls an operation that was listed at an
 * earlier step and is no longer offered. What the SERVER does with that call is
 * the whole question: it looks the name up in the catalogue, performs it, and
 * lets the guard refuse it. An earlier version of `episode.ts` instead turned
 * such calls into a request to `/<toolName>`, which 404s — so the same event was
 * recorded as "invented an endpoint" rather than "used a stale entry", and the
 * harness disagreed with its own server about what had happened.
 *
 * M1 samples only catalogued actions and so never exercised this, which is how
 * the disagreement survived. This asserts it directly.
 */
section("M1c — an unoffered but real tool is refused by the guard, not 404'd");

{
  await resetTo(BASE, { status: "browsing", date: "next-week", partySize: 2 });
  const offered = new Set(((await dyn.surface()).tools ?? []).map((t) => t.name));
  assert(!offered.has("release_hold"), "M1c release_hold is not offered while browsing");

  const viaMcp = await dyn.call("release_hold", {});
  assert(viaMcp.isError, "M1c … and calling it anyway is refused");
  assert(
    /409/.test(viaMcp.text),
    `M1c … by the guard (409), not as a missing route (got: ${viaMcp.text.slice(0, 60)})`,
  );

  const viaHttp = await directly("release_hold", {});
  assert(
    viaHttp.status === 409,
    `M1c … and direct HTTP agrees (got ${viaHttp.status}) — this is the path episode.ts must take`,
  );
}

await statik.close();
await dyn.close();

console.log(
  `\n${failures.length === 0 ? `ALL ${passed} CHECKS PASSED` : `${failures.length} CHECK(S) FAILED (${passed} passed)`}`,
);
process.exit(failures.length === 0 ? 0 : 1);
