/**
 * Session facts the sidebar and footer show, derived from the session branch and tool events.
 *
 * - usage: token and cost totals over the current branch (cached by entry count + leaf id)
 * - modified files: paths written by edit/write tool calls in the branch, with +/- line counts
 * - todos: the latest todo list a `todo`/`todowrite` style tool reported, if any
 * - git: branch and dirty counts, refreshed after each agent run
 */

import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { finite } from "./palette.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface TodoItem {
	text: string;
	done: boolean;
	active?: boolean;
}

export interface GitInfo {
	branch?: string;
	dirty: number;
	ahead: number;
	behind: number;
	/** True when cwd is in a linked worktree rather than the main checkout. */
	worktree?: boolean;
}

let usageCache: { key: string; totals: UsageTotals } | undefined;

export function branchKey(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	return `${branch.length}:${branch.at(-1)?.id ?? ""}`;
}

export function usageTotals(ctx: ExtensionContext): UsageTotals {
	const key = branchKey(ctx);
	if (usageCache?.key === key) return usageCache.totals;
	const t: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const e of ctx.sessionManager.getBranch() as any[]) {
		const u =
			e.type === "message" && (e.message?.role === "assistant" || e.message?.role === "toolResult")
				? e.message.usage
				: e.type === "compaction" || e.type === "branch_summary"
					? e.usage
					: undefined;
		if (!u) continue;
		t.input += finite(u.input);
		t.output += finite(u.output);
		t.cacheRead += finite(u.cacheRead);
		t.cacheWrite += finite(u.cacheWrite);
		t.cost += finite(u.cost?.total);
	}
	usageCache = { key, totals: t };
	return t;
}

/** Count +/- lines in a unified-ish diff string. */
export function diffStats(diff: string | undefined): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of (diff ?? "").split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** Latest todo list from a todo-style tool result in the branch (pi's todo example, todowrite, ...). */
export function latestTodos(ctx: ExtensionContext): TodoItem[] {
	const branch = ctx.sessionManager.getBranch() as any[];
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type !== "message" || e.message?.role !== "toolResult") continue;
		if (!/todo/i.test(e.message.toolName ?? "")) continue;
		const raw = e.message.details?.todos ?? e.message.details?.items;
		if (!Array.isArray(raw)) continue;
		return raw
			.map((t: any) => ({
				text: String(t.text ?? t.content ?? t.title ?? ""),
				done: t.done === true || t.completed === true || t.status === "completed",
				active: t.status === "in_progress",
			}))
			.filter((t: TodoItem) => t.text);
	}
	return [];
}

function git(args: string[], cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: 2000, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? undefined : out));
	});
}

export async function readGit(cwd: string): Promise<GitInfo | undefined> {
	const [out, dirs] = await Promise.all([
		git(["--no-optional-locks", "status", "--porcelain=v1", "--branch"], cwd),
		git(["rev-parse", "--git-dir", "--git-common-dir"], cwd),
	]);
	if (out === undefined) return undefined;
	const info: GitInfo = { dirty: 0, ahead: 0, behind: 0 };
	// In a linked worktree the git dir (.git/worktrees/<name>) differs from the common dir.
	const [gitDir, commonDir] = (dirs ?? "").split("\n");
	if (gitDir && commonDir) info.worktree = resolve(cwd, gitDir) !== resolve(cwd, commonDir);
	for (const line of out.split("\n")) {
		if (line.startsWith("## ")) {
			const b = line.slice(3);
			if (b.startsWith("HEAD (no branch)")) info.branch = "detached";
			else info.branch = b.split("...")[0]?.replace(/^No commits yet on /, "");
			info.ahead = Number(b.match(/ahead (\d+)/)?.[1] ?? 0);
			info.behind = Number(b.match(/behind (\d+)/)?.[1] ?? 0);
		} else if (line.trim()) {
			info.dirty++;
		}
	}
	return info;
}
