/**
 * The thinking peek must find pi's assistant message even when halo's sidebar split wraps the
 * layout root: `tui.layoutRoot` is then a plain object and pi's real root hangs off it under a symbol.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ThinkingPeek } from "../extensions/halo/peek.ts";

const ORIGINAL = Symbol.for("pi-halo/original-root");

function assistant() {
	const labels: string[] = [];
	return {
		labels,
		children: [] as unknown[],
		setHiddenThinkingLabel: (l: string) => void labels.push(l),
		updateContent() {},
	};
}

function fakeTui(layoutRoot: unknown) {
	let renders = 0;
	return { layoutRoot, requestRender: () => void renders++, get renders() { return renders; } } as any;
}

const message = { content: [{ type: "thinking", thinking: "weighing the options" }] };

test("peek finds the assistant message through the wrapped layout root", () => {
	const a = assistant();
	const piRoot = { children: [{ children: [a] }] };
	const wrapper = { [ORIGINAL]: piRoot }; // what installLayout leaves in tui.layoutRoot: no children
	const tui = fakeTui(wrapper);
	new ThinkingPeek(() => tui, () => 80).update(message);
	assert.equal(a.labels.length, 1, "the label was set on the assistant message");
	assert.match(a.labels[0]!, /thinking/);
	assert.match(a.labels[0]!, /weighing the options/);
	assert.equal(tui.renders, 1);
});

test("peek still works when the layout is not wrapped", () => {
	const a = assistant();
	const tui = fakeTui({ children: [a] });
	new ThinkingPeek(() => tui, () => 80).update(message);
	assert.equal(a.labels.length, 1);
});
