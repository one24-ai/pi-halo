/**
 * Tool rows: each built-in tool has its own one-cell Nerd Font glyph, used on the call row.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { icon } from "../extensions/halo/icons.ts";
import { TOOL_ICONS } from "../extensions/halo/tools.ts";

process.env.PI_HALO_ICONS = "nerd"; // the plain set is checked in icons.test.ts

test("every built-in tool has a distinct one-cell icon from the Nerd Font private-use range", () => {
	const names = Object.keys(TOOL_ICONS);
	assert.deepEqual(names.sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
	const glyphs = Object.values(TOOL_ICONS).map((n) => icon(n));
	assert.equal(new Set(glyphs).size, glyphs.length, "no two tools share a glyph");
	for (const g of glyphs) {
		assert.equal(visibleWidth(g), 1);
		assert.ok(g.codePointAt(0)! >= 0xf0001 && g.codePointAt(0)! <= 0xfffff, "nf-md range");
	}
});
