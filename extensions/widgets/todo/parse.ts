/**
 * Finds and parses a repo's TODO file. Pure apart from the file-system lookups, so it's testable.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Most bytes read from a TODO file; a longer file is read up to here and the rest is ignored. */
export const MAX_TODO_BYTES = 256 * 1024;
/** Most items parsed from a TODO file. */
export const MAX_TODO_ITEMS = 500;

/** File names checked at the repo root, in order. */
export const TODO_FILES = ["TODO.md", "TODO", "TODO.txt", "todo.md", "TODO.markdown"];

/** The nearest directory at or above `cwd` that contains `.git`, else `cwd`. */
export function repoRoot(cwd: string): string {
	let dir = cwd;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const up = dirname(dir);
		if (up === dir) return cwd;
		dir = up;
	}
}

/** Path of the repo's TODO file, or undefined. */
export function findTodoFile(cwd: string): string | undefined {
	const root = repoRoot(cwd);
	for (const name of TODO_FILES) {
		const p = join(root, name);
		try {
			if (statSync(p).isFile()) return p;
		} catch {
			// not there
		}
	}
	return undefined;
}

/**
 * Open top-level items: markdown list entries ("- x", "* x", "1. x", "- [ ] x") at the file's
 * shallowest list indent. Checked boxes ("- [x]") and nested sub-items are left out, as are code
 * blocks. A file with no list items falls back to its non-heading, non-blank lines. At most
 * `maxItems` list entries (or plain lines) are looked at; the rest of the text is ignored.
 */
export function parseTodos(content: string, maxItems = MAX_TODO_ITEMS): string[] {
	const items: { indent: number; text: string }[] = [];
	const plain: string[] = [];
	let fence = false;
	for (const raw of content.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(raw)) {
			fence = !fence;
			continue;
		}
		if (fence) continue;
		if (items.length >= maxItems || plain.length >= maxItems) break;
		const m = raw.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
		if (m) {
			const indent = m[1]!.replace(/\t/g, "    ").length;
			let text = m[2]!.trim();
			const box = text.match(/^\[([ xX~-])\]\s*(.*)$/);
			if (box) {
				if (box[1] !== " ") {
					items.push({ indent, text: "" }); // done: keeps its subitems out, then dropped
					continue;
				}
				text = box[2]!.trim();
			}
			items.push({ indent, text });
		} else if (raw.trim() && !/^\s*(#|<!--|---|===)/.test(raw)) {
			plain.push(raw.trim());
		}
	}
	if (!items.length) return plain;
	const top = Math.min(...items.map((i) => i.indent));
	return items.filter((i) => i.indent === top && i.text).map((i) => stripInline(i.text));
}

/** Drops markdown emphasis and link syntax so items read as plain text. */
function stripInline(s: string): string {
	return s
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/`([^`]*)`/g, "$1")
		.trim();
}

/** The first `maxBytes` bytes of a file as text. A multi-byte character cut at the end shows as U+FFFD. */
function readHead(path: string, maxBytes: number): string {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(maxBytes);
		let got = 0;
		while (got < maxBytes) {
			const n = readSync(fd, buf, got, maxBytes - got, got);
			if (n === 0) break;
			got += n;
		}
		return buf.toString("utf8", 0, got);
	} finally {
		closeSync(fd);
	}
}

/**
 * Reads and parses, returning undefined when there is no TODO file. Reads at most `MAX_TODO_BYTES`
 * and parses at most `MAX_TODO_ITEMS` items, so a huge file in a repo cannot stall the sidebar.
 * Callers read a project file only when the project is trusted.
 */
export function readTodos(cwd: string): { path: string; items: string[] } | undefined {
	const path = findTodoFile(cwd);
	if (!path) return undefined;
	try {
		return { path, items: parseTodos(readHead(path, MAX_TODO_BYTES), MAX_TODO_ITEMS) };
	} catch {
		return undefined;
	}
}
