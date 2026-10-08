/** The home screen's bottom bar shows the branch with the same icon as the sidebar and footer. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHomeFooter } from "../extensions/halo/home.ts";
import { ICONS } from "../extensions/halo/icons.ts";
import { createState } from "../extensions/halo/state.ts";

// These tests check the Nerd Font glyphs; the plain set has its own tests in icons.test.ts.
process.env.PI_HALO_ICONS = "nerd";

const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => t } as any;
const strip = (s: string) => s.replace(/<\/?[a-zA-Z]+>/g, "");

function footer(branch?: string) {
	const state = createState();
	state.ctx = { cwd: "/work/project" } as any;
	if (branch) state.git = { branch, dirty: 0, ahead: 0, behind: 0 } as any;
	return renderHomeFooter(state, theme, 100)[1]!;
}

test("home footer: the branch comes with the branch icon, in the accent colour, after the folder", () => {
	const row = footer("feature-x");
	assert.ok(row.includes(`<accent>${ICONS.branch.nerd}</accent>`), "icon in the accent colour");
	const plain = strip(row);
	assert.ok(plain.indexOf("/work/project") < plain.indexOf(ICONS.branch.nerd), "folder first");
	assert.ok(plain.indexOf(ICONS.branch.nerd) < plain.indexOf("feature-x"), "icon before the branch name");
	assert.ok(!plain.includes("project:feature-x"), "no dir:branch form");
});

test("home footer: with no git branch there is no icon", () => {
	const row = footer();
	assert.ok(!row.includes(ICONS.branch.nerd));
	assert.ok(strip(row).includes("/work/project"));
});
