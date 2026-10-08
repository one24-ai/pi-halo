/**
 * Regression test: pointer moves over the split layout must not re-render the transcript.
 *
 * Fullscreen pi reports every mouse move. When our layout root had its own handleMouse, pi-tui
 * dispatched each event to the stack's Container.handleMouse, which re-rendered every message to
 * find the hit row. Long sessions then pinned a CPU core and froze. This drives pi-tui's real
 * fullscreen TUI with a pi-shaped root (scrolling transcript + dock) wrapped by installLayout.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Component, ScrollView, type Terminal, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { installLayout } from "../extensions/halo/layout.ts";
import { createState } from "../extensions/halo/state.ts";

class FakeTerminal implements Terminal {
	onInput: (data: string) => void = () => {};
	start(onInput: (data: string) => void) {
		this.onInput = onInput;
	}
	stop() {}
	async drainInput() {}
	write() {}
	get columns() {
		return 160;
	}
	get rows() {
		return 40;
	}
	get kittyProtocolActive() {
		return false;
	}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgramStatus() {}
	setProgress() {}
}

/** A transcript message that counts how often it renders. */
function message(counter: { renders: number }): Component {
	return {
		invalidate() {},
		render(width: number) {
			counter.renders++;
			return Array.from({ length: 5 }, (_, i) => `line ${i}`.padEnd(width));
		},
	};
}

/** SGR mouse report for a pointer move (button 35 = motion, no button held). 1-based x, y. */
const move = (x: number, y: number) => `\x1b[<35;${x};${y}M`;

test("mouse moves over the split layout do not re-render the transcript", () => {
	const terminal = new FakeTerminal();
	const tui = new TuiAltScreen(terminal);
	const counter = { renders: 0 };
	const transcript = new VStack(Array.from({ length: 200 }, () => message(counter)));
	const dock: Component = { invalidate() {}, render: (w) => ["> prompt".padEnd(w)] };
	const piRoot = new VStack([
		{ component: new ScrollView(transcript), basis: 0, grow: 1, shrink: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 0 },
	]);
	tui.setLayoutRoot(piRoot);

	// Minimal ExtensionContext: installLayout only needs setWidget to reach the TUI and theme.
	// Stub theme: every method returns its last string argument (colour codes are irrelevant here).
	const theme = new Proxy({}, {
		get: (_t, key) => (key === "getColorMode" ? () => "truecolor" : (...args: unknown[]) => String(args.at(-1) ?? "")),
	}) as never;
	const ctx = {
		ui: {
			setWidget(_id: string, factory: ((t: unknown, th: unknown) => Component) | undefined) {
				factory?.(tui, theme);
			},
		},
	} as never;
	const state = createState();
	const handle = installLayout(ctx, state, { width: 42, minTerminalWidth: 110, piVersion: "test", home: () => false, tipIndex: 0 });
	assert.equal(state.layout, "split");

	tui.start();
	tui.renderNow();
	const afterFirstFrame = counter.renders;
	assert.ok(afterFirstFrame > 0);

	// Sweep the pointer across the transcript, the gutter and the sidebar.
	for (let i = 0; i < 50; i++) terminal.onInput(move(5 + i * 3, 2 + (i % 30)));

	// Each full render touches all 200 messages; the old handler did one per event (10,000 here).
	assert.ok(counter.renders - afterFirstFrame < 200, `transcript re-rendered ${counter.renders - afterFirstFrame} times for 50 pointer moves`);

	handle.dispose();
	tui.stop();
});

test("clicks and wheel still reach components inside the split layout", () => {
	const terminal = new FakeTerminal();
	const tui = new TuiAltScreen(terminal);
	const events: string[] = [];
	const counter = { renders: 0 };
	const transcript = new VStack(Array.from({ length: 200 }, () => message(counter)));
	const scroll = new ScrollView(transcript);
	const dock: Component & { handleMouse(e: { type: string }): { handled: boolean } } = {
		invalidate() {},
		render: (w) => ["> prompt".padEnd(w)],
		handleMouse(e) {
			events.push(e.type);
			return { handled: true };
		},
	};
	tui.setLayoutRoot(
		new VStack([
			{ component: scroll, basis: 0, grow: 1, shrink: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 0 },
		]),
	);
	const theme = new Proxy({}, {
		get: (_t, key) => (key === "getColorMode" ? () => "truecolor" : (...args: unknown[]) => String(args.at(-1) ?? "")),
	}) as never;
	const ctx = { ui: { setWidget: (_id: string, f?: (t: unknown, th: unknown) => Component) => void f?.(tui, theme) } } as never;
	const handle = installLayout(ctx, createState(), { width: 42, minTerminalWidth: 110, piVersion: "test", home: () => false, tipIndex: 0 });
	tui.start();
	tui.renderNow();

	// Click on the prompt row (last row, inside the 2-column gutter).
	terminal.onInput("\x1b[<0;10;40M");
	terminal.onInput("\x1b[<0;10;40m");
	assert.ok(events.includes("press"), `dock saw ${JSON.stringify(events)}`);

	// Wheel down over the transcript scrolls it (the ScrollView starts at the top here).
	tui.renderNow();
	const top = scroll.scrollTop;
	terminal.onInput("\x1b[<65;10;10M");
	tui.renderNow();
	assert.ok(scroll.scrollTop > top, `wheel did not scroll the transcript (${top} -> ${scroll.scrollTop})`);

	handle.dispose();
	tui.stop();
});
