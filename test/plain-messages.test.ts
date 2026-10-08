/**
 * Custom messages: halo wraps extension notices in a panel with a bar, except the types that
 * draw a plain row of their own. halo lists none itself: extensions add theirs to the shared set.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomMessageComponent } from "@earendil-works/pi-coding-agent";
import { installMessageStyle, PLAIN_MESSAGE_TYPES } from "../extensions/halo/messages.ts";
import { createState } from "../extensions/halo/state.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const theme = {
	fg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	bg: (_c: string, t: string) => `<bg>${t}`,
	getColorMode: () => "truecolor",
	name: "test",
} as any;

/** A message of this type, drawn by a renderer that returns one plain row, as an extension that styles its own notices does. */
function render(customType: string, width = 80): string[] {
	const message = { role: "custom", customType, content: "x", display: true, timestamp: 0 } as any;
	const renderer = () => ({ invalidate() {}, render: () => [` ${customType} row`] });
	return new CustomMessageComponent(message, renderer as any).render(width);
}

test("halo lists no plain message type of its own", () => {
	assert.equal(PLAIN_MESSAGE_TYPES.size, 0);
});

test("a plain message type is drawn exactly as its own renderer draws it: no bar, no panel", () => {
	const off = installMessageStyle(createState(), () => theme);
	PLAIN_MESSAGE_TYPES.add("quiet-notice");
	try {
		const lines = render("quiet-notice");
		assert.deepEqual(lines.map(strip), ["", " quiet-notice row"], "pi's spacer, then the row as drawn");
		assert.ok(!lines.join("").includes("┃"), "no bar");
		assert.ok(!/\x1b\[48;/.test(lines.join("")), "no shade");
	} finally {
		PLAIN_MESSAGE_TYPES.delete("quiet-notice");
		off();
	}
});

test("other message types still get the panel and the bar", () => {
	const off = installMessageStyle(createState(), () => theme);
	try {
		const lines = render("some-notice");
		assert.ok(lines.join("").includes("┃"), "the bar");
		assert.ok(/\x1b\[48;/.test(lines.join("")), "the shade: a background colour");
	} finally {
		off();
	}
});

test("an extension can add its own plain type through the shared set", () => {
	const shared = (globalThis as any)[Symbol.for("halo.plainMessageTypes")] as Set<string>;
	assert.equal(shared, PLAIN_MESSAGE_TYPES, "one set, found by symbol, so other module scopes share it");
	const off = installMessageStyle(createState(), () => theme);
	try {
		shared.add("my-row");
		const lines = render("my-row");
		assert.ok(!lines.join("").includes("┃"));
	} finally {
		shared.delete("my-row");
		off();
	}
});
