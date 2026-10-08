/**
 * Git diff view: `/diff` (or ctrl+x d) opens a full-size panel with the changed files on the left
 * and the selected file's diff on the right.
 *
 *   /diff           everything not yet committed: staged, unstaged and untracked files, one list
 *   /diff branch    what this branch changed since it left its base branch (main...HEAD)
 *
 * It reads git on open and on `r`, never on a timer. Other extensions can open it with their own
 * diff and add actions to it: see host.ts and client.ts (openDiff, addDiffAction).
 * It is registered as a widget with no slot so `/widgets disable diff` switches it off.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRegistry, registerWidget } from "../halo/api.ts";
import { loadBranch, loadChanges, parseUnifiedDiff } from "./git-diff.ts";
import { diffHost } from "./host.ts";
import type { OpenDiffRequest } from "./types.ts";
import { DiffView, type ViewDeps } from "./view.ts";

const ID = "diff";

const load: ViewDeps["load"] = (source, cwd) => (source === "branch" ? loadBranch(cwd) : loadChanges(cwd));

export default function (pi: ExtensionAPI) {
	const host = diffHost();
	let openNow = false;

	/** Show the panel and resolve true when it closes; false, with nothing shown, when it is already open or there is no terminal UI. */
	const show = async (ctx: ExtensionContext, opts: { initial?: "changes" | "branch"; file?: string; external?: OpenDiffRequest }): Promise<boolean> => {
		if (openNow) return false;
		if (!ctx.hasUI || ctx.mode !== "tui") return false; // the panel is a custom component: only the terminal UI can draw it
		openNow = true;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) =>
					new DiffView({
						tui,
						theme,
						ctx,
						cwd: opts.external?.cwd ?? ctx.cwd,
						actions: () => diffHost().actions,
						done: () => done(),
						load,
						initial: opts.initial,
						file: opts.file,
						external: opts.external ? { title: opts.external.title, files: parseUnifiedDiff(opts.external.diff) } : undefined,
					}),
				{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } },
			);
			return true;
		} finally {
			openNow = false;
		}
	};

	const disabled = (): boolean => getRegistry().disabled.has(ID);

	const open = async (ctx: ExtensionContext, initial?: "changes" | "branch", file?: string): Promise<boolean> => {
		if (disabled()) {
			ctx.ui.notify("The diff view is switched off. /widgets enable diff turns it back on.", "info");
			return false;
		}
		return show(ctx, { initial, file });
	};

	host.openChanges = (ctx, file) => open(ctx, "changes", file);

	host.open = async (ctx, req) => (disabled() ? false : show(ctx, { external: req }));

	registerWidget(pi, {
		id: ID,
		title: "Diff view",
		slots: [], // no sidebar row or footer segment: it exists so /widgets can switch it off
		render: () => undefined,
		actions: [
			{ id: "open", label: "Open the diff view", description: "Staged, unstaged and untracked changes", run: async (ctx) => void (await open(ctx)) },
			{ id: "branch", label: "Diff this branch against its base", description: "What the branch changed since it left main (or the remote's default branch)", run: async (ctx) => void (await open(ctx, "branch")) },
		],
	});

	pi.registerCommand("diff", {
		description: "Git diff view: /diff [branch]",
		getArgumentCompletions: (prefix) => {
			const opts = ["changes", "branch"].filter((o) => o.startsWith(prefix.trim()));
			return opts.length ? opts.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (a && a !== "changes" && a !== "branch") {
				ctx.ui.notify("Usage: /diff [changes|branch]", "warning");
				return;
			}
			await open(ctx, a === "branch" ? "branch" : "changes");
		},
	});

	pi.on("session_shutdown", async () => {
		host.open = undefined;
		host.openChanges = undefined;
	});
}
