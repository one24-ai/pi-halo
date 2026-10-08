/**
 * Run with:
 *   pnpm test
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findTodoFile, MAX_TODO_BYTES, MAX_TODO_ITEMS, parseTodos, readTodos } from "../extensions/widgets/todo/parse.ts";

process.env.PI_HALO_STATE = join(mkdtempSync(join(tmpdir(), "halo-")), "state.json");
const api = await import("../extensions/halo/api.ts");
const { default: installTodoWidget } = await import("../extensions/widgets/todo/index.ts");

test("parseTodos keeps open top-level items only", () => {
	const md = [
		"# TODO",
		"",
		"- Test the provider section",
		"  - sub-item stays hidden",
		"- [ ] Open checkbox with **bold** and `code`",
		"- [x] Done item",
		"  - its sub-item is hidden too",
		"* Star bullet with [a link](https://example.com)",
		"1. Numbered",
		"```",
		"- not an item, in a code block",
		"```",
	].join("\n");
	assert.deepEqual(parseTodos(md), [
		"Test the provider section",
		"Open checkbox with bold and code",
		"Star bullet with a link",
		"Numbered",
	]);
});

test("parseTodos falls back to plain lines and handles empty files", () => {
	assert.deepEqual(parseTodos("# TODO\n\nfix the thing\nship it\n"), ["fix the thing", "ship it"]);
	assert.deepEqual(parseTodos(""), []);
	assert.deepEqual(parseTodos("# TODO\n\n- [x] all done\n"), []);
});

test("findTodoFile looks at the repo root from a subdirectory", () => {
	const root = mkdtempSync(join(tmpdir(), "halo-todo-"));
	try {
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, "src", "deep"), { recursive: true });
		assert.equal(findTodoFile(join(root, "src", "deep")), undefined);
		writeFileSync(join(root, "TODO.md"), "- one\n- two\n");
		assert.equal(findTodoFile(join(root, "src", "deep")), join(root, "TODO.md"));
		assert.deepEqual(readTodos(join(root, "src"))?.items, ["one", "two"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function repoWith(todo: string): string {
	const root = mkdtempSync(join(tmpdir(), "halo-todo-"));
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, "TODO.md"), todo);
	return root;
}

test("parseTodos stops at the item cap", () => {
	const md = Array.from({ length: 50 }, (_, i) => `- item ${i}`).join("\n");
	assert.equal(parseTodos(md, 10).length, 10);
	assert.deepEqual(parseTodos(md, 10)[9], "item 9");
	assert.equal(parseTodos(Array.from({ length: 50 }, (_, i) => `plain ${i}`).join("\n"), 5).length, 5, "plain lines are capped too");
	assert.equal(parseTodos(md).length, 50, "the default cap is far above a normal file");
	assert.equal(MAX_TODO_ITEMS, 500);
});

test("readTodos reads at most MAX_TODO_BYTES of a huge file and at most MAX_TODO_ITEMS items", () => {
	const line = "- a task that is long enough to matter\n";
	const root = repoWith(line.repeat(Math.ceil((MAX_TODO_BYTES * 4) / line.length)));
	try {
		const got = readTodos(root);
		assert.ok(got);
		assert.equal(got.items.length, MAX_TODO_ITEMS);
		// A file of one endless line is cut at the byte cap, not read whole.
		writeFileSync(join(root, "TODO.md"), `- ${"x".repeat(MAX_TODO_BYTES * 3)}`);
		const one = readTodos(root)!.items;
		assert.equal(one.length, 1);
		assert.ok(one[0]!.length <= MAX_TODO_BYTES, `${one[0]!.length}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the todo widget reads TODO.md only when the project is trusted", () => {
	const root = repoWith("- ship it\n- test it\n");
	try {
		const reg = api.getRegistry();
		reg.widgets.clear();
		reg.ctx = undefined;
		installTodoWidget({ on: () => () => {} } as any);
		const spec = reg.widgets.get("todo")!.spec;
		const rc = { theme: { fg: (_c: string, t: string) => t } as any, ctx: undefined, width: 40 };

		spec.update!({ cwd: root, isProjectTrusted: () => false } as any);
		assert.equal(spec.render(rc), undefined, "untrusted: nothing is read, so nothing shows");
		assert.equal(spec.detail!(rc), undefined);

		spec.update!({ cwd: root, isProjectTrusted: () => true } as any);
		assert.deepEqual(spec.render(rc), { text: "2 open" });
		assert.deepEqual(spec.detail!(rc), ["• ship it", "• test it"]);

		// Trust withdrawn (a project switch): the items go away again.
		spec.update!({ cwd: root, isProjectTrusted: () => false } as any);
		assert.equal(spec.render(rc), undefined);
		reg.widgets.clear();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
