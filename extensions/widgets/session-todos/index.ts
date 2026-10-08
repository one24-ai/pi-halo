/**
 * Session todos widget: the latest todo list that a todo-style tool (pi's todo example, todowrite,
 * ...) reported in this session, as its own sidebar section. Hidden when there is no list or
 * everything is done. Separate from the TODO widget, which reads a TODO file in the repo.
 *
 *     Todo
 *     [✓] Read the API
 *     [•] Write the tests
 *     [ ] Update the README
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWidget } from "../../halo/api.ts";
import { ICONS } from "../../halo/icons.ts";
import { primary } from "../../halo/palette.ts";
import { branchKey, latestTodos, type TodoItem } from "../../halo/session-info.ts";

const SHOWN = 12;

/** Open todos only count as visible; a stale ctx after a session switch reads as "none". */
function todosOf(ctx: Parameters<typeof latestTodos>[0] | undefined): TodoItem[] {
	if (!ctx) return [];
	try {
		return latestTodos(ctx);
	} catch {
		return [];
	}
}

export default function (pi: ExtensionAPI) {
	registerWidget(pi, {
		id: "session-todos",
		title: "Todo",
		icon: { nerd: ICONS.widgetSessionTodos.nerd, plain: ICONS.widgetSessionTodos.plain },
		slots: ["sidebar"],
		sidebar: "section",
		order: 50,
		// latestTodos scans the branch; redo it only when the branch changes.
		cacheKey: ({ ctx }) => {
			try {
				return ctx ? branchKey(ctx) : "";
			} catch {
				return ""; // stale ctx after a session switch
			}
		},
		render: ({ ctx }) => (todosOf(ctx).some((t) => !t.done) ? {} : undefined),
		detail: ({ theme, ctx }) =>
			todosOf(ctx)
				.slice(0, SHOWN)
				.map((t) => {
					const box = t.done ? theme.fg("success", "[✓]") : t.active ? primary(theme, "[•]") : theme.fg("muted", "[ ]");
					return `${box} ${t.done ? theme.fg("muted", t.text) : theme.fg("text", t.text)}`;
				}),
	});
}
