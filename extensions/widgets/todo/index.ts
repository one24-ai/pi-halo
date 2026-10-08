/**
 * TODO widget: when the current repo has a TODO file at its root (TODO.md, TODO, TODO.txt, ...),
 * shows it as its own sidebar section: the open item count beside the title and the first few
 * items underneath. Hidden when there's no file or nothing is open. Re-reads the file when it
 * changes. The file belongs to the project, so it is read only when the project is trusted.
 *
 *     TODO  3 open
 *     • Test the provider section…
 *     • Add a cost breakdown
 *     +1 more
 */

import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWidget } from "../../halo/api.ts";
import { ICONS } from "../../halo/icons.ts";
import { sanitize } from "../../halo/palette.ts";
import { findTodoFile, readTodos } from "./parse.ts";

const POLL_MS = 5_000;
const SHOWN = 5;

export default function (pi: ExtensionAPI) {
	let items: string[] = [];
	let key = ""; // path + mtime, so unchanged files aren't re-parsed

	registerWidget(pi, {
		id: "todo",
		title: "TODO",
		icon: { nerd: ICONS.widgetTodo.nerd, plain: ICONS.widgetTodo.plain },
		slots: ["sidebar"],
		sidebar: "section",
		order: 40,
		refreshMs: POLL_MS,
		update: (ctx) => {
			if (!ctx.isProjectTrusted()) {
				items = [];
				key = "";
				return;
			}
			const path = findTodoFile(ctx.cwd);
			if (!path) {
				items = [];
				key = "";
				return;
			}
			let mtime = 0;
			try {
				mtime = statSync(path).mtimeMs;
			} catch {
				// vanished between calls
			}
			const next = `${path}:${mtime}`;
			if (next === key) return;
			key = next;
			items = readTodos(ctx.cwd)?.items ?? [];
		},
		render: () => (items.length ? { text: `${items.length} open` } : undefined),
		detail: ({ theme }) => {
			if (!items.length) return undefined;
			const lines = items.slice(0, SHOWN).map((t) => `${theme.fg("muted", "•")} ${theme.fg("text", sanitize(t))}`);
			if (items.length > SHOWN) lines.push(theme.fg("dim", `+${items.length - SHOWN} more`));
			return lines;
		},
	});
}
