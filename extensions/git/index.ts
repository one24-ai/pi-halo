/**
 * Git workflows without prompting the model for context:
 *
 *   /commit [message]      commit what is staged (or stage everything, after asking); with no
 *                          message the model drafts one from the diff, and you edit or accept it
 *   /push                  push the branch (publishes it with an upstream the first time)
 *   /merge [branch|abort]  merge a branch into the current one; stops cleanly on conflicts
 *   /pr [base] [--draft]   push if needed, draft the title and description from the commits and
 *                          diff, and open the request with gh or glab
 *   /git [status|on|off]   a menu of the above, the repository status, or the off switch
 *
 * Generic: any git remote, any host the gh or glab CLI is signed in to. The commands show up in
 * the command palette like any slash command. The flows are in flows.ts; this file only connects
 * them to pi. `/git off` switches the commands off (saved in halo.json) and `/git on` restores them.
 *
 * Results are also passed to the model on its next turn (a hidden message with the outcome and a
 * fresh repository status), so it never relies on a `git status` from before the command.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commit, type Env, merge, pullRequest, push, showStatus } from "./flows.ts";
import { loadGitEnabled, saveGitEnabled } from "./settings.ts";

const DRAFT_TIMEOUT_MS = 90_000;

/** Ask the current model for text with a one-off request outside the conversation. */
async function draft(ctx: ExtensionContext, prompt: { system: string; user: string }): Promise<string | undefined> {
	const model = ctx.model;
	if (!model) return undefined;
	try {
		const reply = await ctx.modelRegistry
			.streamSimple(model, { systemPrompt: prompt.system, messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }] }, { signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS) })
			.result();
		if (reply.stopReason === "error" || reply.stopReason === "aborted") return undefined;
		const text = reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("").trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

/** The message type of the hidden note that tells the model what a command did. */
const REPORT_TYPE = "halo-git";

function envFor(pi: ExtensionAPI, ctx: ExtensionContext): Env {
	return {
		cwd: ctx.cwd,
		ui: {
			notify: (m, level) => ctx.ui.notify(m, level),
			confirm: (title, message) => ctx.ui.confirm(title, message),
			select: (title, options) => ctx.ui.select(title, options),
			editor: (title, prefill) => ctx.ui.editor(title, prefill),
		},
		draft: (p) => draft(ctx, p),
		report: (r) => pi.sendMessage({ customType: REPORT_TYPE, content: r.content, display: false, details: r.details }, { deliverAs: "nextTurn" }),
	};
}

/** Without a UI (print and JSON modes) notify() shows nothing, so say it on stderr. */
function needInteractive(name: string): void {
	process.stderr.write(`/${name} needs the interactive UI: it reports to you and asks before it changes anything. Run it in an interactive pi session.\n`);
}

const MENU = ["Commit", "Push", "Merge a branch", "Open a pull request", "Status"] as const;

export default function (pi: ExtensionAPI) {
	/** Run a workflow if the UI can talk to the user and the tools are not switched off. */
	const guarded = (fn: (env: Env, args: string) => Promise<unknown>, name: string) => async (args: string, ctx: ExtensionContext) => {
		if (!loadGitEnabled()) return ctx.ui.notify("The git commands are off. /git on turns them back on.", "warning");
		if (!ctx.hasUI) return needInteractive(name);
		try {
			await fn(envFor(pi, ctx), args);
		} catch (e) {
			ctx.ui.notify(`git tools: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	};

	const doCommit = guarded((env, a) => commit(env, a), "commit");
	const doPush = guarded((env) => push(env), "push");
	const doMerge = guarded((env, a) => merge(env, a), "merge");
	const doPr = guarded((env, a) => pullRequest(env, a), "pr");
	const doStatus = guarded((env) => showStatus(env), "git status");

	pi.registerCommand("commit", { description: "Commit staged changes: /commit [message]", handler: doCommit });
	pi.registerCommand("push", { description: "Push the current branch", handler: doPush });
	pi.registerCommand("merge", {
		description: "Merge a branch into this one: /merge [branch|abort]",
		getArgumentCompletions: (prefix) => (["abort"].filter((o) => o.startsWith(prefix.trim())).map((o) => ({ value: o, label: o })) || null),
		handler: doMerge,
	});
	pi.registerCommand("pr", { description: "Open a pull request: /pr [base] [--draft]", handler: doPr });
	pi.registerCommand("git", {
		description: "Git menu, status, or switch: /git [status|on|off]",
		getArgumentCompletions: (prefix) => {
			const opts = ["status", "on", "off"].filter((o) => o.startsWith(prefix.trim()));
			return opts.length ? opts.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				const saved = saveGitEnabled(arg === "on");
				const note = arg === "on" ? "Git commands on." : "Git commands off. /git on turns them back on.";
				return ctx.ui.notify(saved ? note : `${note} (could not save the setting, so it only lasts until pi restarts)`, saved ? "info" : "warning");
			}
			if (arg && arg !== "status") return ctx.ui.notify("Usage: /git [status|on|off]", "warning");
			if (!loadGitEnabled()) return ctx.ui.notify("The git commands are off. /git on turns them back on.", "warning");
			if (arg === "status") return doStatus("", ctx);
			if (!ctx.hasUI) return needInteractive("git");
			const picked = await ctx.ui.select("Git", [...MENU]);
			if (picked === "Commit") return doCommit("", ctx);
			if (picked === "Push") return doPush("", ctx);
			if (picked === "Merge a branch") return doMerge("", ctx);
			if (picked === "Open a pull request") return doPr("", ctx);
			if (picked === "Status") return doStatus("", ctx);
		},
	});
}
