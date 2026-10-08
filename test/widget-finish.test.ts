/**
 * Run with:
 *   pnpm test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.PI_HALO_STATE = join(mkdtempSync(join(tmpdir(), "halo-")), "state.json");
// These tests check the Nerd Font glyphs; the plain set has its own tests in icons.test.ts.
process.env.PI_HALO_ICONS = "nerd";

const api = await import("../extensions/halo/api.ts");
const client = await import("../extensions/halo/client.ts");
const { renderSidebar } = await import("../extensions/halo/sidebar.ts");
const { createState } = await import("../extensions/halo/state.ts");
const { runPaletteValue, paletteItems } = await import("../extensions/halo/commands.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, getColorMode: () => "truecolor" } as any;

/** A pi stand-in whose `on` returns a working unsubscribe, like the real one. */
function fakePi() {
	const handlers = new Map<string, Set<(e: unknown, ctx: unknown) => unknown>>();
	return {
		on: (name: string, fn: (e: unknown, ctx: unknown) => unknown) => {
			const set = handlers.get(name) ?? handlers.set(name, new Set()).get(name)!;
			set.add(fn);
			return () => void set.delete(fn);
		},
		count: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
		fire: async (name: string, ctx: unknown = {}) => {
			for (const fn of [...(handlers.get(name) ?? [])]) await fn({}, ctx);
		},
	} as any;
}

function fresh(): void {
	const reg = api.getRegistry();
	for (const e of reg.widgets.values()) if (e.timer) clearInterval(e.timer);
	reg.widgets.clear();
	reg.disabled.clear();
	reg.ctx = {} as any;
	reg.apiVersion = undefined;
	reg.register = undefined;
}

test("dispose and re-register remove the pi.on handlers they added", () => {
	fresh();
	const pi = fakePi();
	const spec = { id: "l", render: () => ({ text: "x" }) };
	const h = api.registerWidget(pi, spec);
	assert.equal(pi.count(), 2);
	api.registerWidget(pi, spec);
	assert.equal(pi.count(), 2, "re-registering replaced the old handlers");
	api.registerWidget(pi, spec);
	api.registerWidget(pi, spec);
	assert.equal(pi.count(), 2);
	h.dispose(); // an older handle: must not touch the newer entry's handlers
	assert.equal(pi.count(), 2);
	api.registerWidget(pi, spec).dispose();
	assert.equal(pi.count(), 0);
});

test("client fallback handlers are removed on dispose and when the host takes over", () => {
	fresh();
	const pi = fakePi();
	const h = client.registerWidget(pi, { id: "c", render: () => ({ text: "x" }) });
	assert.equal(pi.count(), 2);
	h.dispose();
	assert.equal(pi.count(), 0);
	const pi2 = fakePi();
	client.registerWidget(pi2, { id: "c2", render: () => ({ text: "x" }) });
	api.installHost();
	// The host registered it (2 of its own) and the client dropped its own 2.
	assert.equal(pi2.count(), 2);
	api.getRegistry().widgets.get("c2")?.offs.forEach((off: () => void) => off());
	assert.equal(pi2.count(), 0);
});

test("palette actions: listed, run, and failures reported and recorded", async () => {
	fresh();
	const ran: string[] = [];
	api.registerWidget(fakePi(), {
		id: "aws",
		title: "AWS",
		render: () => ({ text: "x" }),
		actions: [
			{ id: "refresh", label: "Refresh credentials", description: "run the credential switcher", run: () => void ran.push("refresh") },
			{
				id: "bad",
				label: "Explode",
				run: async () => {
					throw new Error("nope\nmore");
				},
			},
		],
	});
	const items = api.widgetActions();
	assert.deepEqual(items.map((a: any) => a.label), ["Refresh credentials", "Explode"]);
	assert.equal(await api.runWidgetAction("aws", "refresh", {} as any), undefined);
	assert.deepEqual(ran, ["refresh"]);
	const msg = await api.runWidgetAction("aws", "bad", {} as any);
	assert.match(msg ?? "", /AWS: Explode failed: nope/);
	assert.equal(api.widgetError("aws")?.phase, "action");
	assert.match((await api.runWidgetAction("aws", "missing", {} as any)) ?? "", /No action/);
	// A later success clears the recorded action error.
	assert.equal(await api.runWidgetAction("aws", "refresh", {} as any), undefined);
	assert.equal(api.widgetError("aws"), undefined, "error from the bad action stays until a success of any action");
});

test("palette actions are hidden while disabled or suspended", () => {
	fresh();
	api.registerWidget(fakePi(), { id: "a", render: () => ({ text: "x" }), actions: [{ id: "go", label: "Go", run: () => {} }] });
	assert.equal(api.widgetActions().length, 1);
	api.setWidgetDisabled("a", true);
	assert.equal(api.widgetActions().length, 0);
	api.setWidgetDisabled("a", false);
	assert.equal(api.widgetActions().length, 1);
	api.getRegistry().widgets.get("a")!.suspended = true;
	assert.equal(api.widgetActions().length, 0);
});

test("action values round-trip, including odd ids, and reach runWidgetAction from the palette", async () => {
	const v = api.widgetActionValue("a:b", "c d/é");
	assert.deepEqual(api.parseWidgetActionValue(v), { widgetId: "a:b", actionId: "c d/é" });
	assert.equal(api.parseWidgetActionValue("/model"), undefined);
	fresh();
	let hit = 0;
	api.registerWidget(fakePi(), { id: "p", render: () => ({ text: "x" }), actions: [{ id: "a", label: "A", run: () => void hit++ }] });
	const notes: string[] = [];
	const ctx = { ui: { notify: (m: string) => notes.push(m) } } as any;
	runPaletteValue(api.widgetActionValue("p", "a"), ctx, [], () => assert.fail("not a slash command"));
	await sleep(5);
	assert.equal(hit, 1);
	runPaletteValue(api.widgetActionValue("p", "zzz"), ctx, [], () => {});
	await sleep(5);
	assert.match(notes[0] ?? "", /No action/);
	const list = paletteItems({ getCommands: () => [] } as any, [], [], [{ value: "widget:x:y", label: "W: Y" }]);
	assert.equal(list[0].value, "widget:x:y", "widget actions come right after the leader actions");
});

test("sidebar: a section widget with no text renders its title and detail lines", () => {
	fresh();
	api.registerWidget(fakePi(), {
		id: "sec",
		title: "Section",
		sidebar: "section",
		render: () => ({}),
		detail: () => ["line one", "line two"],
	});
	const out = renderSidebar(createState(), theme, 42, 30, "1.0.0").map(strip).join("\n");
	assert.match(out, /Section/);
	assert.match(out, /line one/);
	assert.doesNotMatch(out, /undefined/);
});

test("sidebar: a failing widget shows its error on one line that fits the panel", () => {
	fresh();
	api.registerWidget(fakePi(), {
		id: "row",
		title: "Row",
		render: () => {
			throw new Error("a very long failure message that would overflow a forty-two column sidebar");
		},
	});
	api.registerWidget(fakePi(), {
		id: "sec",
		title: "Section",
		sidebar: "section",
		render: () => {
			throw new Error("another very long failure message that would overflow a forty-two column sidebar");
		},
	});
	const lines = renderSidebar(createState(), theme, 42, 30, "1.0.0");
	for (const l of lines) assert.ok(visibleWidth(l) <= 42, `line too wide: ${strip(l)}`);
	const text = lines.map(strip);
	assert.ok(text.some((l) => /render: a very long failure/.test(l)), "row widget error shown");
	assert.ok(text.some((l) => /… *$/.test(l)), "long error is cut with an ellipsis");
	assert.ok(text.some((l) => /error/.test(l) && /Row/.test(l)), "row keeps its error status");
});

test("sidebar: a section widget's icon goes in front of its title, and row markers follow the level", () => {
	fresh();
	api.registerWidget(fakePi(), { id: "sec", title: "Section", icon: "\u{F0B58}", sidebar: "section", render: () => ({ text: "2 running" }) });
	api.registerWidget(fakePi(), { id: "noicon", title: "Plain", sidebar: "section", render: () => ({ text: "x" }) });
	const levels = ["ok", "warn", "error", "off", "info"] as const;
	for (const level of levels) api.registerWidget(fakePi(), { id: `row-${level}`, title: level, order: 1, render: () => ({ text: "v", level }) });
	api.registerWidget(fakePi(), { id: "row-none", title: "none", order: 1, render: () => ({ text: "v" }) });
	const text = renderSidebar(createState(), theme, 60, 40, "1.0.0").map(strip);
	assert.ok(text.some((l) => l.includes("\u{F0B58} Section") && l.includes("2 running")), "icon, title, value");
	assert.ok(text.some((l) => l.trimStart().startsWith("Plain")), "no icon, no gap");
	const marks = { ok: "\u{F05E1}", warn: "\u{F002A}", error: "\u{F015A}", off: "\u{F0377}", info: "\u{F02FD}" };
	for (const level of levels) assert.ok(text.some((l) => l.includes(`${marks[level]}  ${level}`)), `${level} marker, two spaces before the title`);
	assert.ok(text.some((l) => l.includes("•  none")), "a row without a level keeps the dot");
});

test("sidebar: known statuses get their own marker, others keep the bullet, and long names never touch the value", () => {
	fresh();
	const state = createState();
	state.statuses = () =>
		new Map([
			["lsp", "LSP: ts ready"],
			["graphify", "graphify active"],
			["subagent-slash", "3 tools"],
			["subagent-slash-text", "Running reviewer"],
			["other", "Other: fine"],
		]);
	const text = renderSidebar(state, theme, 48, 30, "1.0.0").map(strip);
	const row = (re: RegExp) => text.find((l) => re.test(l)) ?? "";
	assert.ok(row(/LSP/).includes("\u{F0169}"), "lsp marker");
	assert.ok(row(/Graphify/).includes("\u{F104A}"), "graphify marker");
	assert.ok(row(/Other/).includes("•  Other"), "unlisted key keeps the bullet");
	assert.ok(!text.some((l) => /• (LSP|Lsp|Graphify)/.test(l)), "lsp and graphify have no bullet");
	for (const l of text) assert.ok(!/Subagent-slash\S/.test(l) && !/slash-text\S/.test(l), `name runs into its value: ${l}`);
	assert.ok(row(/3 tools/).includes("•") && row(/3 tools/).includes("…"), "an unlisted long name keeps the bullet and is cut with an ellipsis");
});

test("sidebar and footer: a widget's statusKeys hide the raw statuses it covers, and nothing else", async () => {
	fresh();
	api.registerWidget(fakePi(), { id: "subs", title: "Subs", statusKey: "subs-main", statusKeys: ["subs-slash", "subs-slash-text"], render: () => ({ text: "1 running" }) });
	const keys = api.claimedStatusKeys();
	for (const k of ["subs-main", "subs-slash", "subs-slash-text"]) assert.ok(keys.has(k), `${k} claimed`);
	assert.ok(!keys.has("subs"), "an explicit statusKey replaces the id default");
	assert.ok(!keys.has("lsp"));

	const state = createState();
	state.statuses = () => new Map([["subs-slash", "0 tools | ctrl+o live detail"], ["subs-slash-text", "Running reviewer"], ["lsp", "LSP: ts ready"]]);
	const side = renderSidebar(state, theme, 48, 30, "1.0.0").map(strip).join("\n");
	assert.doesNotMatch(side, /live detail|Running reviewer/, "claimed statuses are not listed");
	assert.match(side, /LSP/, "an unclaimed status still is");

	const { renderFooter } = await import("../extensions/halo/footer.ts");
	state.sidebarShown = () => false;
	const data = { getGitBranch: () => undefined, getExtensionStatuses: () => state.statuses() } as any;
	const foot = renderFooter(state, theme, data, 200).map(strip).join("\n");
	assert.doesNotMatch(foot, /live detail|Running reviewer/, "and the footer skips them too");
	assert.match(foot, /LSP/);
});

test("the built-in Subagents widget claims pi-subagents' slash statuses", async () => {
	fresh();
	const { default: install } = await import("../extensions/widgets/subagents/index.ts");
	install({ events: { on: () => () => {} }, on: () => {}, getSettings: () => ({}) } as any);
	const keys = api.claimedStatusKeys();
	assert.ok(keys.has("subagent-slash") && keys.has("subagent-slash-text"));
});

test("sidebar: a row widget's icon is its marker, in place of the bullet and the level marker, and not repeated by the value", () => {
	fresh();
	const logo = "\u{F0E0F}";
	api.registerWidget(fakePi(), { id: "withicon", title: "Logo", icon: logo, render: () => ({ icon: logo, text: "acct-1" }) });
	api.registerWidget(fakePi(), { id: "lvl", title: "Lvl", icon: logo, render: () => ({ text: "x", level: "warn" }) });
	api.registerWidget(fakePi(), { id: "plain", title: "Plain", render: () => ({ icon: "*", text: "acct-2" }) });
	const text = renderSidebar(createState(), theme, 48, 30, "1.0.0").map(strip);
	const row = (re: RegExp) => text.find((l) => re.test(l)) ?? "";
	assert.ok(row(/acct-1/).includes(`${logo}  Logo`), "the icon is the marker, two spaces before the title");
	assert.ok(!row(/acct-1/).includes("•"), "and there is no bullet");
	assert.equal((row(/acct-1/).match(new RegExp(logo, "g")) ?? []).length, 1, "the logo appears once, not again beside the value");
	assert.ok(row(/Lvl/).includes(`${logo}  Lvl`) && !row(/Lvl/).includes("\u{F002A}"), "an icon wins over the level marker");
	assert.ok(row(/acct-2/).includes("•  Plain") && row(/acct-2/).includes("* acct-2"), "a widget without an icon keeps the bullet and the value icon");
});

test("the AWS widget shows the AWS logo as its row marker and not beside the account", async () => {
	fresh();
	process.env.AWS_ACCESS_KEY_ID = "ASIAIOSFODNN7EXAMPLE";
	process.env.AWS_REGION = "us-west-2";
	const { default: install } = await import("../extensions/widgets/aws/index.ts");
	install({ events: { on: () => () => {} }, on: () => {}, getSettings: () => ({}) } as any);
	const entry = api.getRegistry().widgets.get("aws")!;
	await entry.spec.update!(undefined as any);
	const state = createState();
	state.ctx = { cwd: "/w", model: { provider: "p", id: "m" }, getContextUsage: () => undefined, sessionManager: { getSessionName: () => "d", getBranch: () => [] } } as any;
	const text = renderSidebar(state, theme, 48, 30, "1.0.0").map(strip);
	const line = text.find((l) => /AWS\s+\d{12}/.test(l))!;
	assert.ok(line, "AWS row present");
	assert.ok(line.includes("\u{F0EF}  AWS"), "the full-size logo, two spaces, then the title");
	assert.equal((line.match(/\u{F0EF}/gu) ?? []).length, 1, "the logo is not repeated beside the account");
	assert.ok(!line.includes("•") && !line.includes("\u{F0E0F}"), "no bullet and no md-aws glyph");
	const detail = text.slice(text.indexOf(line) + 1, text.indexOf(line) + 4).join("\n");
	assert.match(detail, /region us-west-2/, "the region detail is still there");
	assert.doesNotMatch(detail, /env keys|profile /, "and the source line (env keys, profile name) is not");

	// With the sidebar hidden the footer still draws the logo in front of the account, with room after it.
	const { renderFooter } = await import("../extensions/halo/footer.ts");
	state.sidebarShown = () => false;
	const data = { getGitBranch: () => undefined, getExtensionStatuses: () => new Map() } as any;
	const foot = renderFooter(state, theme, data, 200).map(strip).join("\n");
	assert.match(foot, /\u{F0EF} {2}\d{12}/u, "footer: logo, then two spaces (one for its overhang), then the account");
	delete process.env.AWS_ACCESS_KEY_ID;
	delete process.env.AWS_REGION;
});

test("the AWS widget counts down to env key expiry: plain, then a warning, then expired", async () => {
	fresh();
	delete process.env.PI_AWS_SESSION_EXPIRATION; // a live session may have one
	delete process.env.AWS_CREDENTIAL_EXPIRATION;
	process.env.AWS_ACCESS_KEY_ID = "ASIAIOSFODNN7EXAMPLE";
	const { default: install } = await import("../extensions/widgets/aws/index.ts");
	install({ events: { on: () => () => {} }, on: () => {}, getSettings: () => ({}) } as any);
	const entry = api.getRegistry().widgets.get("aws")!;
	assert.equal(entry.spec.refreshMs, 30_000, "re-renders by itself so the countdown moves");
	const state = createState();
	state.ctx = { cwd: "/w", model: { provider: "p", id: "m" }, getContextUsage: () => undefined, sessionManager: { getSessionName: () => "d", getBranch: () => [] } } as any;
	const shown = async (ms: number | undefined) => {
		if (ms === undefined) delete process.env.AWS_CREDENTIAL_EXPIRATION;
		else process.env.AWS_CREDENTIAL_EXPIRATION = new Date(Date.now() + ms).toISOString();
		await entry.spec.update!(undefined as any);
		return renderSidebar(state, theme, 48, 30, "1.0.0").map(strip).join("\n");
	};
	assert.doesNotMatch(await shown(undefined), /expire/, "no expiry variable, no countdown");
	assert.match(await shown(62 * 60_000 + 5_000), /expires in 1h 02m/);
	assert.match(await shown(5 * 60_000 + 5_000), /AWS\s+\S+ \(5m\)/, "inside ten minutes the row itself carries the time");
	assert.match(await shown(-1000), /credentials expired/);
	// A profile session (no keys) counts down from the switcher's time.
	delete process.env.AWS_ACCESS_KEY_ID;
	delete process.env.AWS_CREDENTIAL_EXPIRATION;
	process.env.AWS_PROFILE = "sso";
	process.env.PI_AWS_SESSION_EXPIRATION = new Date(Date.now() + 42 * 60_000 + 5_000).toISOString();
	await entry.spec.update!(undefined as any);
	assert.match(renderSidebar(state, theme, 48, 30, "1.0.0").map(strip).join("\n"), /expires in 42m/);
	delete process.env.AWS_PROFILE;
	delete process.env.PI_AWS_SESSION_EXPIRATION;
});

test("sidebar: markers of different widths leave every row's label in the same column, with the gap after a wide marker", () => {
	fresh();
	api.registerWidget(fakePi(), { id: "wide", title: "Wide", icon: "\u{F0EF}", render: () => ({ text: "v1" }) });
	api.registerWidget(fakePi(), { id: "lvl", title: "Lvl", render: () => ({ text: "v2", level: "ok" }) });
	api.registerWidget(fakePi(), { id: "dot", title: "Dot", render: () => ({ text: "v3" }) });
	api.registerWidget(fakePi(), { id: "det", title: "Det", render: () => ({ text: "v4" }), detail: () => ["under the value"] });
	const text = renderSidebar(createState(), theme, 48, 30, "1.0.0").map(strip);
	// Columns are display widths: a marker above U+FFFF is two UTF-16 units but one cell, so
	// String.indexOf would report the label one column too far along.
	const col = (re: RegExp, word: string) => {
		const l = text.find((x) => re.test(x))!;
		return visibleWidth(l.slice(0, l.indexOf(word)));
	};
	const labels = [col(/v1/, "Wide"), col(/v2/, "Lvl"), col(/v3/, "Dot"), col(/v4/, "Det")];
	assert.equal(new Set(labels).size, 1, `labels start in one column: ${labels}`);
	assert.equal(col(/under the value/, "under"), col(/v4/, "v4"), "detail lines line up under the values");
	assert.ok(text.find((l) => /v1/.test(l))!.includes("\u{F0EF}  Wide"), "two spaces after the wide logo");
});

test("sidebar: the git branch is drawn with the Octicons branch glyph, dirty and ahead counts after it", () => {
	fresh();
	const state = createState();
	state.git = { branch: "main", dirty: 3, ahead: 1, behind: 0 };
	const text = renderSidebar(state, theme, 48, 30, "1.0.0").map(strip);
	const line = text.find((l) => l.includes("main"))!;
	assert.ok(line, "a branch line is drawn");
	assert.ok(line.includes("\uF418 main"), "the glyph, one space, the branch");
	assert.ok(line.includes("●3") && line.includes("↑1"), "and its counts");
	assert.ok(!line.includes("\uE0A0"), "not the old Powerline glyph");
});

test("footer: with the sidebar hidden the branch has the same glyph as the sidebar, and nothing when the sidebar is shown", async () => {
	fresh();
	const { renderFooter } = await import("../extensions/halo/footer.ts");
	const state = createState();
	state.git = { branch: "main", dirty: 2, ahead: 0, behind: 1 };
	const data = { getGitBranch: () => undefined, getExtensionStatuses: () => new Map() } as any;
	state.sidebarShown = () => false;
	const hidden = renderFooter(state, theme, data, 160).map(strip).join("\n");
	assert.ok(hidden.includes("\uF418 main"), "glyph, one space, the branch");
	assert.ok(hidden.includes("●2") && hidden.includes("↓1"), "and its counts");
	assert.ok(!hidden.includes("\uE0A0"), "not the old Powerline glyph");
	state.sidebarShown = () => true;
	assert.ok(!renderFooter(state, theme, data, 160).map(strip).join("\n").includes("main"), "the sidebar shows the branch, so the footer leaves it out");

	// Branch from pi's own footer data when halo has not read git yet.
	state.sidebarShown = () => false;
	state.git = undefined;
	const viaPi = renderFooter(state, theme, { ...data, getGitBranch: () => "release" }, 160).map(strip).join("\n");
	assert.ok(viaPi.includes("\uF418 release"), "the fallback branch gets the glyph too");
});
