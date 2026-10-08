/**
 * Tab on an empty prompt switches Build/Plan. Shift+Tab is not taken by halo: it goes on to pi,
 * whose binding cycles the thinking level. Driven through the real PromptEditor and pi's keybindings.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { PromptEditor } from "../extensions/halo/editor.ts";
import { createState } from "../extensions/halo/state.ts";

initTheme("dark", false);

/**
 * pi's KeybindingsManager is not importable from the package, so this stands in for it. The keys are
 * pi's defaults (dist/core/keybindings.js): app.thinking.cycle is shift+tab; the rest are not pressed here.
 */
const keybindings = { matches: (data: string, action: string) => action === "app.thinking.cycle" && matchesKey(data, "shift+tab") } as any;

const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

function setup() {
	const cycled: string[] = [];
	const thinking: string[] = [];
	const tui = { requestRender() {}, terminal: { columns: 100, rows: 30 } } as any;
	const editorTheme = { borderColor: (s: string) => s, selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s, description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s } } as any;
	const editor = new PromptEditor(tui, editorTheme, keybindings, {
		state: createState(),
		theme: () => ({ fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t }) as any,
		modelParts: () => ({ model: "m", provider: "p", effort: undefined }),
		onModeCycle: () => void cycled.push("mode"),
		onLeaderKey: () => false,
		onLeaderState: () => {},
		onPalette: () => {},
		leaderTimeoutMs: 1000,
	} as any);
	// pi registers its thinking cycle like this (interactive-mode.js).
	editor.onAction("app.thinking.cycle", () => void thinking.push("cycle"));
	return { editor, cycled, thinking };
}

test("tab on an empty prompt switches the mode and leaves thinking alone", () => {
	const { editor, cycled, thinking } = setup();
	editor.handleInput(TAB);
	assert.deepEqual(cycled, ["mode"]);
	assert.deepEqual(thinking, []);
});

test("shift+tab on an empty prompt cycles thinking (pi's action) and does not switch the mode", () => {
	const { editor, cycled, thinking } = setup();
	editor.handleInput(SHIFT_TAB);
	assert.deepEqual(thinking, ["cycle"]);
	assert.deepEqual(cycled, []);
});

test("shift+tab with text in the prompt still cycles thinking", () => {
	const { editor, cycled, thinking } = setup();
	editor.setText("hello");
	editor.handleInput(SHIFT_TAB);
	assert.deepEqual(thinking, ["cycle"]);
	assert.deepEqual(cycled, []);
});

test("the rail keeps the exact mode colour under a light theme, where text in that colour is darkened", () => {
	const { editor } = setup();
	const light: any = { appearance: "light", name: "light", getColorMode: () => "truecolor", fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };
	(editor as any).hooks.theme = () => light;
	const rail = (editor.render(60).find((l) => l.includes("┃")) ?? "").match(/\x1b\[38;2;(\d+);(\d+);(\d+)m┃/);
	assert.ok(rail, "the rail is drawn with a truecolor foreground");
	assert.deepEqual([Number(rail![1]), Number(rail![2]), Number(rail![3])], [0x4f, 0x8e, 0xb3], "the brand primary, not a darkened copy");
});
