/** Reading a repository: status, branches, remotes. Nothing here changes anything. */

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { git, gitOut } from "./run.ts";
import { plainText } from "./text.ts";

export interface RepoStatus {
	branch?: string;
	/** The tracked branch ("origin/feat"); absent when there is none or it no longer exists. */
	upstream?: string;
	/** The tracked branch's name when it was deleted on the remote (git status says "[gone]"). */
	gone?: string;
	ahead: number;
	behind: number;
	staged: number;
	unstaged: number;
	untracked: number;
	conflicted: number;
}

/** Parse `git status --porcelain=v1 --branch`. */
export function parseStatus(out: string): RepoStatus {
	const s: RepoStatus = { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
	for (const line of out.split("\n")) {
		if (line.startsWith("## ")) {
			const b = line.slice(3);
			if (b.startsWith("HEAD (no branch)")) continue;
			const [names = "", rest = ""] = b.split(/ \[/, 2);
			const [local = "", upstream] = names.replace(/^No commits yet on /, "").split("...");
			s.branch = local || undefined;
			if (upstream && /\bgone\b/.test(rest)) s.gone = upstream;
			else s.upstream = upstream || undefined;
			s.ahead = Number(rest.match(/ahead (\d+)/)?.[1] ?? 0);
			s.behind = Number(rest.match(/behind (\d+)/)?.[1] ?? 0);
			continue;
		}
		if (line.length < 3) continue;
		const x = line[0]!;
		const y = line[1]!;
		if (x === "?" && y === "?") s.untracked++;
		else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) s.conflicted++;
		else {
			if (x !== " " && x !== "!") s.staged++;
			if (y !== " " && y !== "!") s.unstaged++;
		}
	}
	return s;
}

/**
 * The paths `git add -A` would stage, as git status lists them (one per file, also inside new
 * directories), for showing before anything is staged. Undefined when git could not say.
 */
export async function changedPaths(cwd: string): Promise<string[] | undefined> {
	const r = await git(cwd, ["--no-optional-locks", "-c", "core.quotepath=off", "status", "--porcelain=v1", "-z", "-uall"]);
	if (r.code !== 0) return undefined;
	const parts = r.stdout.split("\0");
	const paths: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;
		if (p.length < 4) continue;
		paths.push(plainText(p.slice(3)));
		if (p[0] === "R" || p[0] === "C" || p[1] === "R" || p[1] === "C") i++; // skip the rename's origin
	}
	return paths;
}

/** A saved copy of the index: call `staged` after your own staging, and `restore` to undo it. */
export interface IndexSnapshot {
	/** Note what the index holds after the staging, so `restore` can tell if anything else changed it since. */
	staged(): Promise<void>;
	/** Put the index back as it was. Resolves false, leaving it alone, when something else changed it since `staged`. */
	restore(): Promise<boolean>;
}

/**
 * Save the index (the staging area) so a command that stages files can undo that if it is
 * dropped. The index file itself is copied, because `git write-tree` and `read-tree` would lose
 * entries added with `git add -N`. It is put back with git's own lock file (`index.lock`), so it
 * cannot collide with a git command running at the same time. Undefined when it cannot be read.
 */
export async function saveIndex(cwd: string): Promise<IndexSnapshot | undefined> {
	const where = await gitOut(cwd, ["rev-parse", "--git-path", "index"]);
	if (!where) return undefined;
	const path = resolve(cwd, where);
	const before = await readFile(path).catch(() => undefined); // a new repository has no index file yet
	/** What the index holds, ignoring the file-stat data git refreshes on its own. */
	const entries = async (): Promise<string | undefined> => {
		const r = await git(cwd, ["ls-files", "--stage", "-z"]);
		return r.code === 0 ? r.stdout : undefined;
	};
	let after: string | undefined;
	return {
		staged: async () => void (after = await entries()),
		restore: async () => {
			// Take git's lock first, so nothing can stage between the check and the swap.
			const lock = `${path}.lock`;
			try {
				await writeFile(lock, before ?? "", { flag: "wx" });
			} catch {
				return false; // another git command holds the lock
			}
			try {
				const now = await entries();
				if (now === undefined || now !== after) {
					await rm(lock, { force: true });
					return false;
				}
				if (before) await rename(lock, path);
				else {
					await rm(path, { force: true });
					await rm(lock, { force: true });
				}
				return true;
			} catch {
				await rm(lock, { force: true }).catch(() => {});
				return false;
			}
		},
	};
}

export async function repoStatus(cwd: string): Promise<RepoStatus | undefined> {
	const r = await git(cwd, ["--no-optional-locks", "status", "--porcelain=v1", "--branch"]);
	return r.code === 0 ? parseStatus(r.stdout) : undefined;
}

/** The current branch, or undefined when HEAD is detached. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
	return (await gitOut(cwd, ["branch", "--show-current"])) || undefined;
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
	return (await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0;
}

/** The remote a branch publishes to: its upstream's remote, else origin, else the first remote. */
export async function remoteName(cwd: string, upstream?: string): Promise<string | undefined> {
	const names = (await gitOut(cwd, ["remote"]))?.split("\n").filter(Boolean) ?? [];
	if (!names.length) return undefined;
	const fromUpstream = upstream ? names.find((n) => upstream.startsWith(`${n}/`)) : undefined;
	return fromUpstream ?? (names.includes("origin") ? "origin" : names[0]);
}

/** Branch names tried, in this order, when the remote does not say which one is its default. */
const COMMON_BASES = ["main", "master"];

/**
 * The branch changes are normally merged into: the remote's HEAD (so a repository whose default is
 * develop or trunk works), else main or master on the remote, else main or master locally.
 */
export async function defaultBranch(cwd: string, remote = "origin"): Promise<string | undefined> {
	const head = await gitOut(cwd, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
	const prefix = `${remote}/`;
	if (head) return head.startsWith(prefix) ? head.slice(prefix.length) : head;
	for (const name of COMMON_BASES) if (await refExists(cwd, `refs/remotes/${remote}/${name}`)) return name;
	for (const name of COMMON_BASES) if (await refExists(cwd, `refs/heads/${name}`)) return name;
	return undefined;
}

/** The ref to compare with for a base branch: the remote's copy when there is one (a local copy can be stale), else the local branch. */
export async function compareRef(cwd: string, remote: string, base: string): Promise<string | undefined> {
	if (await refExists(cwd, `refs/remotes/${remote}/${base}`)) return `${remote}/${base}`;
	return (await refExists(cwd, `refs/heads/${base}`)) ? base : undefined;
}

/** The remote and branch a local branch tracks, from its git config; undefined when it tracks nothing. */
export async function trackedBranch(cwd: string, branch: string): Promise<{ remote: string; branch: string } | undefined> {
	const [remote, merge] = await Promise.all([gitOut(cwd, ["config", "--get", `branch.${branch}.remote`]), gitOut(cwd, ["config", "--get", `branch.${branch}.merge`])]);
	if (!remote || !merge) return undefined;
	return { remote, branch: merge.replace(/^refs\/heads\//, "") };
}

/** Commits on each side of `HEAD` and `ref`: how many only HEAD has (ahead) and only `ref` has (behind). */
export async function aheadBehind(cwd: string, ref: string): Promise<{ ahead: number; behind: number } | undefined> {
	const out = await gitOut(cwd, ["rev-list", "--left-right", "--count", `HEAD...${ref}`]);
	const [ahead, behind] = out?.split(/\s+/).map(Number) ?? [];
	return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead: ahead!, behind: behind! } : undefined;
}

/** The host of a remote URL: https, ssh:// and scp-style (git@host:path) forms. */
export function remoteHost(url: string): string | undefined {
	const u = url.trim();
	const scheme = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/i);
	if (scheme) return scheme[1]!.toLowerCase();
	const scp = u.match(/^(?:[^@/]+@)?([^:/]+):(?!\/\/)/);
	return scp ? scp[1]!.toLowerCase() : undefined;
}

/** Local branch names other than `except`, most recently used first. */
export async function localBranches(cwd: string, except?: string): Promise<string[]> {
	const out = await gitOut(cwd, ["branch", "--sort=-committerdate", "--format=%(refname:short)"]);
	return (out?.split("\n").filter(Boolean) ?? []).filter((b) => b !== except && !b.startsWith("("));
}

/** True when `cwd` is inside a git work tree. */
export async function isRepo(cwd: string): Promise<boolean> {
	return (await gitOut(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
}
