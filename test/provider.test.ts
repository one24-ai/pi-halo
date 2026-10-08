/**
 * Provider status: the sidebar's provider section and the footer take their extra bars from a
 * registered spec, and know nothing about any particular provider.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerProviderStatus } from "../extensions/halo/client.ts";
import { renderFooter } from "../extensions/halo/footer.ts";
import { getProviderStatus, providerStatusKeys, resetProviderStatus } from "../extensions/halo/provider.ts";
import { ICONS, usageIcon } from "../extensions/halo/icons.ts";
import { providerFooterText, providerMeters } from "../extensions/halo/provider-view.ts";
import { renderSidebar } from "../extensions/halo/sidebar.ts";
import { createState } from "../extensions/halo/state.ts";

// These tests check the Nerd Font glyphs; the plain set has its own tests in icons.test.ts.
process.env.PI_HALO_ICONS = "nerd";

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, getColorMode: () => "truecolor" } as any;

/** A session context for one provider; getBranch is empty so usage totals are zero. */
function ctxFor(provider: string): any {
	return {
		cwd: "/work/app",
		model: { provider, id: "model-x", name: "Model X" },
		getContextUsage: () => ({ tokens: 40_000, contextWindow: 1_000_000, percent: 4 }),
		sessionManager: { getSessionName: () => "demo", getBranch: () => [] },
	};
}

function stateFor(provider: string, statuses: Record<string, string> = {}, displayNames: Record<string, string> = {}) {
	const state = createState();
	const ctx = ctxFor(provider);
	// pi's ModelRegistry returns the id itself for a provider that has no registered name
	ctx.modelRegistry = { getProviderDisplayName: (id: string) => displayNames[id] ?? id };
	state.ctx = ctx;
	state.statuses = () => new Map(Object.entries(statuses));
	return state;
}

afterEach(() => resetProviderStatus());

test("no registration: generic heading from the provider id, and a status that is not usage stays in the generic list", () => {
	const out = renderSidebar(stateFor("acme", { "acme-usage": "Acme ready" }), theme, 42, 30, "1.0.0").map(strip).join("\n");
	assert.match(out, new RegExp(`${ICONS.provider.nerd} Acme\\s+Model X`));
	assert.match(out, /Context/);
	assert.doesNotMatch(out, /Plan/);
	assert.match(out, /Acme-usage\s+Acme ready/, "no percentage, so it falls through to the generic list");
});

test("no registration: a <provider>-usage status with a percentage becomes the Plan bar", () => {
	const out = renderSidebar(stateFor("acme", { "acme-usage": "◆ Acme 71%", lsp: "LSP ready" }), theme, 42, 30, "1.0.0").map(strip);
	assert.ok(out.some((l) => /Plan\s+━+\s+71%/.test(l)));
	assert.doesNotMatch(out.join("\n"), /Acme-usage/, "and it leaves the generic list");
	assert.match(out.join("\n"), /Lsp|LSP/, "other statuses stay");
	const other = renderSidebar(stateFor("other", { "acme-usage": "◆ Acme 71%" }), theme, 42, 30, "1.0.0").map(strip).join("\n");
	assert.doesNotMatch(other, /Plan/, "only the active provider's own status counts");
	assert.match(other, /Acme-usage/);
});

test("no registration: the footer shows the conventional usage next to context when the sidebar is hidden", () => {
	const state = stateFor("acme", { "acme-usage": "◆ Acme 71%" });
	state.sidebarShown = () => false;
	const data = { getGitBranch: () => undefined, getExtensionStatuses: () => state.statuses() } as any;
	const line = strip(renderFooter(state, theme, data, 160)[0]!);
	assert.match(line, /acme 71%/);
	assert.equal((line.match(/71%/g) ?? []).length, 1, "shown once");
});

test("statusKey spec: name, a Plan bar from the status, and the status leaves the generic list", () => {
	registerProviderStatus({ provider: "acme", name: "Acme Cloud", statusKey: "acme-usage", label: "Plan" });
	const out = renderSidebar(stateFor("acme", { "acme-usage": "◆ Acme 71%" }), theme, 42, 30, "1.0.0").map(strip);
	const text = out.join("\n");
	assert.match(text, new RegExp(`${ICONS.provider.nerd} Acme Cloud\\s+Model X`));
	assert.ok(out.some((l) => /Plan\s+━+\s+71%/.test(l)), "Plan bar at 71%");
	assert.doesNotMatch(text, /Acme-usage/);
	for (const l of renderSidebar(stateFor("acme", { "acme-usage": "◆ Acme 71%" }), theme, 42, 30, "1.0.0")) assert.ok(visibleWidth(l) <= 42);
});

test("a spec only applies to its own provider", () => {
	registerProviderStatus({ provider: "acme", statusKey: "acme-usage" });
	const out = renderSidebar(stateFor("other", { "acme-usage": "Acme 71%" }), theme, 42, 30, "1.0.0").map(strip).join("\n");
	assert.doesNotMatch(out, /Plan/);
	assert.ok(providerStatusKeys().has("acme-usage"));
	assert.equal(getProviderStatus("other"), undefined);
});

test("meters(): extra bars with detail lines, and a throwing hook is ignored", () => {
	registerProviderStatus({
		provider: ["acme", "acme-eu"],
		meters: () => [{ label: "Quota", percent: 25, detail: "5 of 20 requests" }, { label: "Burst", percent: Number.NaN }],
	});
	assert.ok(getProviderStatus("acme-eu"), "a spec can cover several provider ids");
	const out = renderSidebar(stateFor("acme-eu"), theme, 42, 30, "1.0.0").map(strip);
	assert.ok(out.some((l) => /Quota\s+━+\s+25%/.test(l)));
	assert.ok(out.some((l) => /5 of 20 requests/.test(l)));
	assert.ok(out.some((l) => /Burst\s+━+\s+–/.test(l)), "a non-number shows a dash");

	registerProviderStatus({ provider: "boom", meters: () => { throw new Error("nope"); } });
	assert.doesNotThrow(() => renderSidebar(stateFor("boom"), theme, 42, 30, "1.0.0"));
});

test("a later registration replaces the earlier one for the same provider; undo removes it", () => {
	registerProviderStatus({ provider: "acme", name: "One" });
	const undo = registerProviderStatus({ provider: "acme", name: "Two" });
	assert.equal(getProviderStatus("acme")?.name, "Two");
	undo();
	assert.equal(getProviderStatus("acme"), undefined, "replaced specs are gone, so undo leaves none (same as a /reload)");
	undo(); // calling it twice is harmless
	assert.equal(getProviderStatus("acme"), undefined);
});

test("statusKey colour is kept for the bar and the footer text", () => {
	const spec = { provider: "acme", name: "Acme", statusKey: "acme-usage" };
	const red = "\x1b[31m◆ Acme 91%\x1b[39m";
	const m = providerMeters(spec, ctxFor("acme"), new Map([["acme-usage", red]]));
	assert.equal(m.length, 1);
	assert.equal(m[0]!.percent, 91);
	assert.equal(m[0]!.sgr, "\x1b[31m");
	const foot = providerFooterText(spec, ctxFor("acme"), new Map([["acme-usage", red]]));
	assert.equal(strip(foot), "91%");
	assert.ok(foot.startsWith("\x1b[31m"));
	assert.deepEqual(providerMeters(spec, ctxFor("acme"), new Map([["acme-usage", "no number here"]])), []);
});

test("footer: sidebar hidden shows the provider's usage next to context, and skips its status elsewhere", () => {
	registerProviderStatus({ provider: "acme", name: "Acme", statusKey: "acme-usage" });
	const state = stateFor("acme", { "acme-usage": "◆ Acme 71%", lsp: "LSP ready" });
	state.sidebarShown = () => false;
	const data = { getGitBranch: () => undefined, getExtensionStatuses: () => state.statuses() } as any;
	const line = strip(renderFooter(state, theme, data, 160)[0]!);
	assert.match(line, /acme 71%/);
	assert.match(line, /LSP ready/);
	assert.equal((line.match(/71%/g) ?? []).length, 1, "shown once");
});

test("heading: spec name, else pi's registered display name, else the capitalised id", () => {
	const head = (state: ReturnType<typeof stateFor>) => renderSidebar(state, theme, 42, 30, "1.0.0").map(strip).find((l) => l.includes(ICONS.provider.nerd))!;
	assert.match(head(stateFor("openai", {}, { openai: "OpenAI" })), new RegExp(`${ICONS.provider.nerd} OpenAI\\s+Model X`));
	assert.match(head(stateFor("openai")), new RegExp(`${ICONS.provider.nerd} Openai\\s+Model X`), "no registered name: capitalised id");
	registerProviderStatus({ provider: "openai", name: "Acme AI" });
	assert.match(head(stateFor("openai", {}, { openai: "OpenAI" })), new RegExp(`${ICONS.provider.nerd} Acme AI\\s+Model X`), "spec name wins");
});

test("heading survives a registry that throws or is missing", () => {
	const state = createState();
	const ctx = ctxFor("acme");
	state.ctx = ctx;
	state.statuses = () => new Map();
	ctx.modelRegistry = { getProviderDisplayName: () => { throw new Error("stale"); } };
	assert.ok(renderSidebar(state, theme, 42, 30, "1.0.0").map(strip).some((l) => l.includes(`${ICONS.provider.nerd} Acme`)));
	delete ctx.modelRegistry;
	assert.ok(renderSidebar(state, theme, 42, 30, "1.0.0").map(strip).some((l) => l.includes(`${ICONS.provider.nerd} Acme`)));
});

test("usageGlyph: outline at zero or unknown, then eighths up to a full circle", () => {
	const slice = (n: number) => String.fromCodePoint(0xf0a9d + n);
	assert.equal(usageIcon(0), "\u{F0766}");
	assert.equal(usageIcon(undefined), "\u{F0766}");
	assert.equal(usageIcon(Number.NaN), "\u{F0766}");
	assert.equal(usageIcon(4), "\u{F0766}", "under a sixteenth rounds to empty");
	assert.equal(usageIcon(13), slice(1));
	assert.equal(usageIcon(50), slice(4));
	assert.equal(usageIcon(71), slice(6));
	assert.equal(usageIcon(100), slice(8));
	assert.equal(usageIcon(250), slice(8), "clamped");
	assert.equal(usageIcon(-5), "\u{F0766}", "clamped");
});

test("plan and context rows get a gauge glyph in the bar's colour", () => {
	registerProviderStatus({ provider: "acme", statusKey: "acme-usage" });
	// Tags instead of escapes, and a wide sidebar so the tags don't get the rows truncated.
	const tagged = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => t, getColorMode: () => "truecolor" } as any;
	const render = (pct: number) => renderSidebar(stateFor("acme", { "acme-usage": `Acme ${pct}%` }), tagged, 200, 30, "1.0.0").map((l) => l.replace(/\x1b\[[0-9;:]*m/g, ""));
	for (const [pct, colour] of [[30, "accent"], [70, "warning"], [90, "error"]] as const) {
		const rows = render(pct);
		const plan = rows.find((l) => l.includes("Plan"))!;
		const context = rows.find((l) => l.includes("Context"))!;
		assert.ok(plan.includes(`<${colour}>${usageIcon(pct)}</${colour}> <muted>Plan`), `${pct}%: glyph in ${colour}, just before the label`);
		assert.ok(context.includes(`<accent>${usageIcon(4)}</accent> <muted>Context`), "context (4% here) has its own gauge, in accent");
	}
	for (const l of renderSidebar(stateFor("acme", { "acme-usage": "Acme 71%" }), theme, 42, 30, "1.0.0")) assert.ok(visibleWidth(l) <= 42, "rows keep the sidebar width");
});

test("heading: a trailing parenthetical in pi's provider name is dropped", () => {
	const head = (names: Record<string, string>, id: string) => {
		const state = stateFor(id, {}, names);
		return renderSidebar(state, theme, 48, 30, "1.0.0").map(strip).find((l) => l.includes(ICONS.provider.nerd))!;
	};
	assert.match(head({ acme: "Acme (Builder ID / Google / GitHub)" }, "acme"), new RegExp(`${ICONS.provider.nerd} Acme\\s+Model X`), "login dialog title cut to the name");
	assert.match(head({ openai: "ChatGPT Plus/Pro (Codex Subscription)" }, "openai"), new RegExp(`${ICONS.provider.nerd} ChatGPT Plus/Pro\\s+Model X`));
	assert.match(head({ acme: "Acme (EU) Cloud" }, "acme"), new RegExp(`${ICONS.provider.nerd} Acme \\(EU\\) Cloud\\s+Model X`), "a parenthetical in the middle stays");
	assert.match(head({ acme: "(Internal)" }, "acme"), new RegExp(`${ICONS.provider.nerd} Acme\\s+Model X`), "nothing left falls back to the capitalised id");
	assert.match(head({ acme: "Acme" }, "acme"), new RegExp(`${ICONS.provider.nerd} Acme\\s+Model X`), "a plain name is untouched");
});
