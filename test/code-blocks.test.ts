/**
 * Tool rows: edit and write are blocks like bash; blocks have OpenCode's left border strip; the
 * blank row above an inline row depends on the row above; the sibling lookup reaches pi's root.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { piRootOf } from "../extensions/halo/layout.ts";
import { isTall } from "../extensions/halo/messages.ts";
import { countLines, makeRenderers, SPECS } from "../extensions/halo/tools.ts";

initTheme("dark", false);

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t, getColorMode: () => "truecolor" } as any;
const shaded = (raw: string) => raw.includes("48;2;");

function finished(name: string, args: any, result: any, { isError = false, expanded = false, width = 80 } = {}): string[] {
	const r = makeRenderers(SPECS[name]!, () => "/repo");
	const ctx: any = { args, state: {}, cwd: "/repo", isError, invalidate() {} };
	return r.renderResult(result, { expanded, isPartial: false }, theme, ctx).render(width);
}

const DIFF = "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n context\n-old line\n+new line\n context2\n";
const file = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

test("countLines: a final newline ends a line, it does not start one", () => {
	assert.equal(countLines("a\nb\n"), 2);
	assert.equal(countLines("a\nb"), 2);
	assert.equal(countLines("a\n"), 1);
	assert.equal(countLines(""), 0);
	assert.equal(countLines(undefined), 0);
});

test("write: a block with the numbered lines, and a count that matches them", () => {
	const raw = finished("write", { path: "a.py", content: file(5) }, { content: [{ type: "text", text: "ok" }] });
	assert.ok(raw.some(shaded), "a block, not a plain line");
	const text = raw.map(strip);
	assert.ok(text.some((l) => l.includes("Write") && l.includes("a.py") && l.includes("+5")), "title and the right count");
	assert.ok(text.some((l) => /^\s+1\s+line 1/.test(l)) && text.some((l) => /^\s+5\s+line 5/.test(l)), "numbered lines");
});

test("write: long files show 20 lines and a note that counts the rest, indented like bash output", () => {
	const text = finished("write", { path: "a.py", content: file(38) }, { content: [] }).map(strip);
	assert.ok(text.some((l) => /^\s+20\s+line 20/.test(l)) && !text.some((l) => /\b21\s+line 21/.test(l)));
	const note = text.find((l) => l.includes("more lines"))!;
	assert.ok(note.includes("18 more lines") && note.includes("ctrl+o"), note);
	// Border strip (1) + the block's own space (1) + two columns, the same as bash's output lines.
	assert.ok(/^ {4}… /.test(note), `indent of the note: ${JSON.stringify(note.slice(0, 6))}`);
	const bash = finished("bash", { command: "echo hi" }, { content: [{ type: "text", text: "hi\n" }] }).map(strip).find((l) => l.includes("hi") && !l.includes("echo"))!;
	assert.equal(note.indexOf("…"), bash.indexOf("hi"), "the note starts in the column where bash's output starts");
	assert.ok(text.some((l) => l.includes("+38")), "the summary says 38, the same as 20 shown plus 18");
});

test("edit: a block holding the diff, with +/- counts on the title row", () => {
	const raw = finished("edit", { path: "a.ts" }, { content: [], details: { diff: DIFF } });
	assert.ok(raw.some(shaded));
	const text = raw.map(strip);
	assert.ok(text.some((l) => l.includes("Edit") && l.includes("a.ts") && l.includes("+1") && l.includes("-1")));
	assert.ok(text.some((l) => l.includes("old line")) && text.some((l) => l.includes("new line")), "the diff is under the title");
});

test("edit and write that failed, or have nothing to show, stay as they were", () => {
	const err = finished("edit", { path: "a.ts" }, { content: [{ type: "text", text: "Could not find the text" }] }, { isError: true });
	assert.ok(err.some((l) => strip(l).includes("Could not find")));
	const noDiff = finished("edit", { path: "a.ts" }, { content: [], details: {} });
	assert.equal(noDiff.length, 1, "no diff: one plain line");
	assert.ok(!shaded(noDiff[0]!));
	const empty = finished("write", { path: "a.ts", content: "" }, { content: [] });
	assert.equal(empty.length, 1, "an empty file: one plain line");
});

test("expanded: edit keeps up to 120 diff lines, write up to 120 numbered lines", () => {
	const text = finished("write", { path: "a.py", content: file(200) }, { content: [] }, { expanded: true }).map(strip);
	assert.ok(text.some((l) => /\b120\s+line 120/.test(l)) && !text.some((l) => /\b121\s+line 121/.test(l)));
	assert.ok(text.some((l) => l.includes("80 more lines")) && !text.some((l) => l.includes("ctrl+o")), "no hint once open");
});

test("blocks: a column of page background, then the panel shade, and every line exactly the width", () => {
	for (const width of [40, 80, 120]) {
		const raw = finished("edit", { path: "a.ts" }, { content: [], details: { diff: DIFF } }, { width });
		for (const line of raw) {
			assert.equal(visibleWidth(line), width, `width ${width}`);
			assert.ok(line.startsWith(" \x1b[48;2;"), "unshaded first column, then the shade");
		}
	}
	const bash = finished("bash", { command: "echo hi" }, { content: [{ type: "text", text: "hi\n" }] });
	for (const line of bash) assert.ok(line.startsWith(" \x1b[48;2;"), "bash blocks too");
});

test("isTall: a block is tall, a one-line row with its blank lead is not, a failing render is not", () => {
	const row = (lines: string[]) => ({ render: () => lines }) as any;
	assert.equal(isTall(row(["", " 󰧮 Read a.ts"]), 80), false, "inline row and its blank lead");
	assert.equal(isTall(row([" 󰧮 Read a.ts"]), 80), false);
	assert.equal(isTall(row(["", " \x1b[48;2;1;1;1m   \x1b[49m", " \x1b[48;2;1;1;1m x \x1b[49m", " \x1b[48;2;1;1;1m   \x1b[49m"]), 80), true, "a block");
	assert.equal(isTall({ render() { throw new Error("x"); } } as any, 80), false);
});

test("piRootOf: pi's own root behind halo's layout wrapper, or the tui itself when there is none", () => {
	const original = { children: [{ constructor: { name: "ToolExecutionComponent" } }] };
	const wrapper: any = { render: () => [] };
	wrapper[Symbol.for("pi-halo/original-root")] = original;
	assert.equal(piRootOf({ layoutRoot: wrapper }), original, "through the wrapper");
	const plain = { children: [] };
	assert.equal(piRootOf({ layoutRoot: plain }), plain, "an unwrapped root is itself");
	const tui = { children: [] };
	assert.equal(piRootOf(tui), tui, "no layout root: the tui");
	assert.equal(piRootOf(undefined), undefined);
});
