/**
 * figures.ts — the two pictures the design chapter needs.
 *
 * Both are generated from a running site, never drawn by hand, so what appears in
 * the thesis is the artifact the prototype actually produces.
 *
 *   CONSUMERS   the site's own page, beside the surface A generates from it.
 *               Same state, same A(s), two consumers. The controls match because
 *               they are not two things: the representation a person reads IS the
 *               action set an agent parses. Nothing in the generated pane was
 *               authored for agents, and nothing in the site's pane was authored
 *               for this thesis.
 *
 *   SURFACES    the SAME renderer fed the hypermedia surface and the catalogue
 *               surface in the SAME state. One offers what is possible now; the
 *               other offers everything the application can ever do, most of it
 *               dead. This is the over-offer figure from `elicitation-scan.ts`
 *               made visible: a user looking at the right-hand pane is looking at
 *               buttons that do nothing.
 *
 * The catalogue pane is the only place A is told something it cannot perceive —
 * which of its controls are dead. A holds no such facts; the harness supplies
 * them, which is why `present.ts` takes `dead` as a parameter (see its header).
 *
 * Usage:  pnpm exp:figures            # every preset
 *         pnpm exp:figures --state browsing
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discover } from "../a/discover.ts";
import { presentationStyle, toFragment } from "../a/present.ts";
import { render } from "../a/render.ts";
import { BASE, pageHtml, setSession, startSite } from "../b1/explore.ts";
import { type ActionId, type Session, freshSession, validAffordances } from "../b1/model.ts";
import { actionIdOf } from "./judge.ts";
import { McpSession } from "./mcp-client.ts";
import { catalogueSurface } from "./surface.ts";

export {}; // module, so top-level await is allowed

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "figures");

/**
 * States chosen for what they show, not for flattering numbers: one with several
 * controls that differ only in a fixed value, one on each side of the deposit
 * gate, and one on each side of the cancellation window.
 */
const PRESETS: { name: string; caption: string; session: Session }[] = [
  {
    name: "browsing",
    caption:
      "Browsing a date with free tables. Five controls differ only in the slot each one fixes — " +
      "the value travels inside the control that consumes it, so nobody is asked which slot.",
    session: { ...freshSession(), date: "next-week", partySize: 2 },
  },
  {
    name: "deposit-pending",
    caption:
      "A party of eight, above the deposit threshold. There is no confirm control here at all: " +
      "for this party size the only way forward is the deposit. The threshold lives on the server.",
    session: {
      ...freshSession(),
      status: "deposit_pending",
      date: "next-week",
      partySize: 8,
      slot: "19:00",
      guest: { name: "Ada Lovelace", phone: "+358 40 123 4567" },
    },
  },
  {
    name: "confirmed-near",
    caption:
      "A confirmed booking less than 24 hours from seating. Cancelling outright is absent; " +
      "the same intent is served by a request that declares the reason it needs.",
    session: {
      ...freshSession(),
      status: "confirmed",
      date: "tomorrow",
      partySize: 2,
      slot: "19:00",
      guest: { name: "Ada Lovelace", phone: "+358 40 123 4567" },
      bookingId: "R00042",
    },
  },
];

const PAGE_STYLE = `
${presentationStyle}
body { padding: 0; background: #eee; }
.fig { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #ccc; min-height: 100vh; }
.fig.three { grid-template-columns: 1fr 1fr 1fr; }
.pane { background: #fafafa; padding: 1.25rem; overflow: auto; }
.pane > h2 { font-size: .78rem; text-transform: uppercase; letter-spacing: .07em; color: #666; margin: 0 0 .1rem; }
.pane > .sub { font-size: .8rem; color: #777; margin: 0 0 1rem; }
.caption { grid-column: 1 / -1; background: #fff; padding: .9rem 1.25rem; font-size: .85rem; color: #444; border-bottom: 1px solid #ddd; }
.caption b { color: #111; }
iframe { width: 100%; height: 30rem; border: 1px solid #d4d4d4; border-radius: 6px; background: #fff; }
.count { font-size: .75rem; color: #666; margin: 0 0 .8rem; }
.count b { color: #111; }
`;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, caption: string, panes: string[]): string {
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8">`,
    `<title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body>`,
    `<div class="fig${panes.length === 3 ? " three" : ""}"><div class="caption">${caption}</div>`,
    ...panes.map((p) => `<div class="pane">${p}</div>`),
    `</div></body></html>`,
  ].join("");
}

// ── generate ─────────────────────────────────────────────────────────────────

await startSite();
// The middle pane of figure 2 is condition X+, taken from the real server.
const mcp = await McpSession.start({ dynamic: true, base: BASE });
mkdirSync(OUT, { recursive: true });

const wanted = process.argv.indexOf("--state");
const only = wanted >= 0 ? process.argv[wanted + 1] : "";
const presets = only ? PRESETS.filter((p) => p.name === only) : PRESETS;
if (presets.length === 0) throw new Error(`no preset named "${only}"`);

const written: string[] = [];

for (const preset of presets) {
  await setSession(preset.session);
  const html = await pageHtml();

  const affordances = discover(html);
  const hControls = render(affordances);
  const valid = new Set<ActionId>(validAffordances(preset.session).map((a) => a.id as ActionId));

  // ── figure 1: the site's page and the generated surface, side by side ──────
  //
  // srcdoc rather than a file reference: the site's page carries its own styling
  // and must not inherit this one, and an inline document sidesteps every
  // restriction a browser puts on file:// frames.
  const consumers = page(
    `${preset.name} — one representation, two consumers`,
    `<b>One representation, two consumers.</b> ${esc(preset.caption)}`,
    [
      `<h2>The site's own page</h2><p class="sub">What a person browsing sees.</p>` +
        `<iframe srcdoc="${esc(html)}"></iframe>`,
      `<h2>The surface A generates</h2>` +
        `<p class="sub">Parsed from that same page, rendered without a model.</p>` +
        `<p class="count"><b>${hControls.length}</b> controls, all executable now.</p>` +
        toFragment(hControls, { base: BASE }),
    ],
  );
  const f1 = join(OUT, `${preset.name}-consumers.html`);
  writeFileSync(f1, consumers);
  written.push(f1);

  // ── figure 2: the same renderer over two action sources ───────────────────
  const jAffordances = catalogueSurface(false);
  const jControls = render(jAffordances);
  const deadKeys = new Set(
    jAffordances
      .map((a, i) => {
        const id = actionIdOf(a, BASE);
        return id === null || !valid.has(id) ? jControls[i].key : "";
      })
      .filter(Boolean),
  );

  // The middle pane is what makes the figure argue rather than merely contrast.
  // X+ offers the same operations H does — the over-offering is gone — but it
  // names its parameters instead of carrying their values, so the questions the
  // interface has to ask reappear. Read left to right, the two things H does are
  // separated: it narrows the set, AND it binds the values.
  //
  // It comes from the REAL MCP server's `tools/list`, not from a filtered
  // catalogue built here. The middle pane is a picture of an actual condition,
  // and a hand-rolled stand-in would make the figure an illustration of our
  // argument rather than a rendering of what the experiment runs.
  const mAffordances = (await mcp.surface()).affordances;
  const mControls = render(mAffordances);
  const askCount = (cs: typeof hControls): number =>
    cs.reduce((n, c) => n + c.widgets.filter((w) => w.demand === "asked").length, 0);

  const surfaces = page(
    `${preset.name} — the same renderer, three action sources`,
    `<b>The same renderer, three action sources.</b> ${esc(preset.caption)} ` +
      `All three panes are drawn by the same code from the same state; only where the action ` +
      `set came from differs. Left to right: the catalogue over-offers; filtering it fixes that ` +
      `but still asks for values the state already fixed; only the representation carries them.`,
    [
      `<h2>Hypermedia surface</h2><p class="sub">The controls the server placed in the representation.</p>` +
        `<p class="count"><b>${hControls.length}</b> offered, <b>0</b> dead ` +
        `<i>(structural)</i>, <b>${askCount(hControls)}</b> questions.</p>` +
        toFragment(hControls, { base: BASE }),
      `<h2>MCP, dynamic tool list</h2><p class="sub">The operations legal now, as the tool table a real MCP server serves.</p>` +
        `<p class="count"><b>${mControls.length}</b> offered, <b>0</b> dead ` +
        `<i>(structural)</i>, <b>${askCount(mControls)}</b> questions.</p>` +
        toFragment(mControls, { base: BASE }),
      `<h2>Static catalogue</h2><p class="sub">Every operation the application supports, unfiltered.</p>` +
        `<p class="count"><b>${jControls.length}</b> offered, <b>${deadKeys.size}</b> dead ` +
        `<i>(${((deadKeys.size / jControls.length) * 100).toFixed(0)}%)</i>, ` +
        `<b>${askCount(jControls)}</b> questions.</p>` +
        toFragment(jControls, { base: BASE, dead: deadKeys }),
    ],
  );
  const f2 = join(OUT, `${preset.name}-surfaces.html`);
  writeFileSync(f2, surfaces);
  written.push(f2);

  console.log(
    `${preset.name.padEnd(16)} ` +
      `H ${String(hControls.length).padStart(2)}/0 dead, ${askCount(hControls)} ask   ` +
      `X+ ${String(mControls.length).padStart(2)}/0 dead, ${askCount(mControls)} ask   ` +
      `J ${jControls.length}/${deadKeys.size} dead, ${askCount(jControls)} ask`,
  );
}

// ── an index, so the figures are browsable ───────────────────────────────────

const index = [
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Generated figures</title>`,
  `<style>${presentationStyle}</style></head><body>`,
  `<h1>Generated figures</h1>`,
  `<p class="note">Produced by <code>pnpm exp:figures</code> against a live site. ` +
    `Each pair shows one state.</p>`,
  ...presets.map(
    (p) =>
      `<h2 style="font-size:.95rem;margin:1.2rem 0 .3rem">${esc(p.name)}</h2>` +
      `<p class="note" style="margin:0 0 .4rem">${esc(p.caption)}</p><p>` +
      `<a href="${esc(p.name)}-consumers.html">one representation, two consumers</a> &nbsp;·&nbsp; ` +
      `<a href="${esc(p.name)}-surfaces.html">the same renderer, three action sources</a></p>`,
  ),
  `</body></html>`,
].join("");
writeFileSync(join(OUT, "index.html"), index);

await mcp.close();

console.log(`\n${written.length + 1} files → ${OUT}`);
console.log(`open ${join(OUT, "index.html")}`);

// `startSite` leaves an express listener holding the event loop open.
process.exit(0);
