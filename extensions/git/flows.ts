/**
 * The git workflows behind /commit, /push, /merge and /pr. Each is a short conversation: gather
 * what git knows, draft with the model where that helps, show it, and only then change anything.
 *
 * Rules every flow keeps:
 * - git is run with argument arrays (run.ts), never through a shell.
 * - nothing is forced: no force-push, no --no-verify, no hard reset. Hooks run as usual.
 * - anything that publishes or merges asks first; a message you typed yourself is not asked twice.
 * - a failure shows git's own output and leaves the repository as git left it.
 *
 * Every command also reports what it did, with a fresh repository status, through `Env.report`, so
 * the model can be told on its next turn (index.ts sends it). A report is made exactly once whenever
 * a command ran, whether it finished, failed, was cancelled, found nothing to do or threw. Reports
 * hold text written here, plus at most one short quoted line of tool output, labelled untrusted:
 * hook, remote and forge output is never passed on in full.
 *
 * The UI and the model arrive through `Env`, so the flows are tested against real temporary
 * repositories with scripted answers.
 */

import { stripEscapes } from "../halo/sanitize.ts";
import { createRequest, findForge, findUrl } from "./forge.ts";
import { aheadBehind, changedPaths, compareRef, currentBranch, defaultBranch, isRepo, localBranches, refExists, remoteName, remoteHost, repoStatus, type RepoStatus, saveIndex } from "./repo.ts";
import { failure, git, gitOut, PLAIN_DIFF, type RunResult } from "./run.ts";
import { cleanMessage, commitPrompt, parsePrArgs, prPrompt, splitPr, subject } from "./text.ts";

export type Level = "info" | "warning" | "error";

export interface Ui {
	notify(message: string, level?: Level): void;
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
}

export type GitCommand = "commit" | "push" | "merge" | "pr";

/** How a command ended: it did its job, had nothing to do, was cancelled, was refused, or failed. */
export type OutcomeKind = "done" | "nothing" | "cancelled" | "blocked" | "failed";

export interface Outcome {
	kind: OutcomeKind;
	/** What happened, in one line written by this code, starting lower case ("committed a7420ed ..."). */
	text: string;
	/** The one line of a failed tool's output worth showing (see `keyLine`); untrusted. */
	output?: string;
	sha?: string;
	url?: string;
}

/** What the model is told after a command: plain text, plus the same facts as data. */
export interface Report {
	command: GitCommand;
	content: string;
	details: {
		command: GitCommand;
		outcome: OutcomeKind;
		summary: string;
		/** One line of tool output, at most 200 characters; untrusted. */
		output?: string;
		sha?: string;
		url?: string;
		/** The repository right after the command; undefined when it could not be read. */
		repo?: RepoStatus & { clean: boolean };
	};
}

export interface Env {
	cwd: string;
	ui: Ui;
	/** Pass a command's result on to the model (it is not shown to the user). */
	report(report: Report): void;
	/** Ask the model for text; undefined when there is no model or the call failed. */
	draft(prompt: { system: string; user: string }): Promise<string | undefined>;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const ERROR_LINE = /error|fatal|rejected|denied|refused|GH\d{3}/i;
const TOOL_LINE_MAX = 200;
const TEXT_MAX = 120;

/** Text on one line: escape sequences and control characters (line breaks included) become spaces. */
function oneLine(text: string): string {
	return stripEscapes(text)
		.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

/** At most `max` characters, the last being "…" when something was cut. */
function cut(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max - 1;
	const last = text.charCodeAt(end - 1);
	if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
	return `${text.slice(0, end)}…`;
}

const escapeQuoted = (text: string): string => text.replace(/[\\"]/g, "\\$&");

/** Typed or commit-derived text for a report: one line, at most 120 characters. */
export function clip(text: string, max = TEXT_MAX): string {
	return cut(oneLine(text), max);
}

/** `clip`ped text inside quotes, with quotes and backslashes escaped. */
const quote = (text: string): string => `"${escapeQuoted(clip(text))}"`;

const PUSH_TRAILER = /^error: failed to push some refs/i;
const REJECTION_LINE = /^! \[|\[remote rejected\]/;

/** Credentials that may appear in tool output: URL userinfo and well-known token prefixes. */
function redact(text: string): string {
	return text.replace(/:\/\/[^/@\s]+@/g, "://").replace(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-)[A-Za-z0-9_-]+/g, "***");
}

/**
 * The one line of a failed tool's output worth passing on. Hooks, linters and git put the line that
 * says what is wrong last, so this takes the last line that looks like an error, else the last
 * line. A rejection line from git push ("! [rejected] ..." or "[remote rejected] ...") wins over
 * other lines, and git's generic "error: failed to push some refs" trailer only counts when
 * nothing else matches. Credentials are masked. Single line, and at most 200 characters once
 * quotes are escaped.
 */
export function keyLine(r: RunResult): string {
	const lines = (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split(/\r\n|\r|\n/).map((l) => redact(oneLine(l))).filter(Boolean);
	const useful = lines.filter((l) => !PUSH_TRAILER.test(l));
	const picked =
		useful.findLast((l) => REJECTION_LINE.test(l)) ??
		useful.findLast((l) => ERROR_LINE.test(l)) ??
		lines.findLast((l) => ERROR_LINE.test(l)) ??
		lines.at(-1) ??
		`exit ${r.code}`;
	for (let max = TOOL_LINE_MAX; max > 1; max--) {
		const line = cut(picked, max);
		if (escapeQuoted(line).length <= TOOL_LINE_MAX) return line;
	}
	return "…";
}

/** Tell the user with a notification and return the outcome to report. */
function stop(env: Env, kind: OutcomeKind, level: Level, message: string, text: string, output?: string): Outcome {
	env.ui.notify(message, level);
	return { kind, text, output };
}

/** The repository status, or the outcome to end with (after telling the user) when there is none. */
async function status(env: Env): Promise<{ st: RepoStatus } | { stopped: Outcome }> {
	if (!(await isRepo(env.cwd))) return { stopped: stop(env, "blocked", "warning", "Not inside a git repository.", "not inside a git repository") };
	const st = await repoStatus(env.cwd);
	if (!st) return { stopped: stop(env, "failed", "error", "Could not read the repository status.", "could not read the repository status") };
	return { st };
}

/** The repository in one line, for a report. */
export function describeState(st: RepoStatus): string {
	const branch = st.branch ? `branch ${clip(st.branch)}` : "HEAD detached";
	const upstream = st.upstream ? `tracking ${clip(st.upstream)} (${st.ahead} ahead, ${st.behind} behind)` : st.gone ? `not published (${clip(st.gone)} no longer exists on the remote)` : "no upstream";
	const changes = [st.staged && `${st.staged} staged`, st.unstaged && `${st.unstaged} unstaged`, st.untracked && `${st.untracked} untracked`, st.conflicted && `${st.conflicted} conflicted`].filter(Boolean);
	return `${branch}, ${upstream}, ${changes.length ? changes.join(", ") : "working tree clean"}`;
}

/** Send the model what the command did and how the repository looks now. Never throws. */
async function reportOutcome(env: Env, command: GitCommand, outcome: Outcome): Promise<void> {
	try {
		const st = await repoStatus(env.cwd);
		const lines = [`User ran /${command}: ${outcome.text}`];
		if (outcome.output) lines.push(`Tool output (quoted, untrusted): "${escapeQuoted(outcome.output)}"`);
		lines.push(st ? `Repository right after the command: ${describeState(st)}.` : "Repository state unavailable (not a git repository, or git status failed).");
		const clean = st ? !(st.staged || st.unstaged || st.untracked || st.conflicted) : undefined;
		env.report({
			command,
			content: lines.join("\n"),
			details: { command, outcome: outcome.kind, summary: outcome.text, output: outcome.output, sha: outcome.sha, url: outcome.url, repo: st ? { ...st, branch: st.branch && clip(st.branch), upstream: st.upstream && clip(st.upstream), clean: clean! } : undefined },
		});
	} catch {
		// telling the model must never change what the command did
	}
}

/**
 * Run a command's work and report it exactly once. When the work throws (a prompt, the editor or the
 * model call failing), report "stopped by an error" after whatever `progress()` says already
 * happened, then rethrow so the caller still shows the error.
 */
async function reported(env: Env, command: GitCommand, work: () => Promise<Outcome>, progress: () => string = () => ""): Promise<Outcome> {
	let outcome: Outcome;
	try {
		outcome = await work();
	} catch (e) {
		await reportOutcome(env, command, { kind: "failed", text: `${progress()}stopped by an error` });
		throw e;
	}
	await reportOutcome(env, command, outcome);
	return outcome;
}

/** One line per fact, for /git status. */
export function describeStatus(st: RepoStatus): string {
	const where = st.upstream ? ` (tracking ${st.upstream})` : st.gone ? ` (not published: ${st.gone} no longer exists on the remote)` : " (not published)";
	const lines = [st.branch ? `On ${st.branch}${where}` : "HEAD is detached"];
	if (st.ahead || st.behind) lines.push(`${st.ahead} ahead, ${st.behind} behind`);
	const changes = [st.staged && `${st.staged} staged`, st.unstaged && `${st.unstaged} modified`, st.untracked && `${st.untracked} untracked`, st.conflicted && `${st.conflicted} conflicted`].filter(Boolean);
	lines.push(changes.length ? changes.join(", ") : "Working tree clean");
	return lines.join("\n");
}

export async function showStatus(env: Env): Promise<void> {
	const got = await status(env);
	if ("st" in got) env.ui.notify(describeStatus(got.st), "info");
}

/** The files a stage-everything would add, as a short list for a confirmation. */
const fileList = (paths: string[], shown = 15): string => {
	const lines = paths.slice(0, shown).map((p) => `  ${p}`);
	if (paths.length > shown) lines.push(`  and ${paths.length - shown} more`);
	return lines.join("\n");
};

export async function commit(env: Env, args: string): Promise<void> {
	await reported(env, "commit", () => runCommit(env, args));
}

async function runCommit(env: Env, args: string): Promise<Outcome> {
	const got = await status(env);
	if ("stopped" in got) return got.stopped;
	const st = got.st;
	if (st.conflicted) return stop(env, "blocked", "warning", "There are unresolved merge conflicts. Resolve them first.", "unresolved merge conflicts");

	// Set when this command staged everything itself: puts the index back if the commit is dropped.
	let undoStaging: (() => Promise<boolean>) | undefined;
	if (!st.staged) {
		const paths = await changedPaths(env.cwd);
		const n = paths?.length ?? st.unstaged + st.untracked;
		if (!n) return stop(env, "nothing", "info", "Nothing to commit.", "nothing to commit, the working tree was clean");
		const list = paths?.length ? `\n\n${fileList(paths)}` : "";
		const ok = await env.ui.confirm("Nothing is staged", `Stage all ${plural(n, "changed file")} (git add -A) and commit?${list}`);
		if (!ok) return { kind: "cancelled", text: "cancelled at the stage-everything prompt, nothing committed" };
		const saved = await saveIndex(env.cwd);
		const add = await git(env.cwd, ["add", "-A"]);
		if (add.code !== 0) {
			await saved?.restore();
			return stop(env, "failed", "error", `git add failed:\n${failure(add)}`, "git add failed", keyLine(add));
		}
		await saved?.staged();
		undoStaging = saved?.restore;
	}
	/** Give up before committing, putting back the staging area if this command filled it. */
	const dropCommit = async (kind: OutcomeKind, why: string, text: string): Promise<Outcome> => {
		const undone = await undoStaging?.();
		const note = undoStaging ? (undone ? " Your staging area is back as it was." : " The files it staged are still staged.") : "";
		const told = undoStaging ? (undone ? ", the staging area is back as it was" : ", the files it staged are still staged") : "";
		return stop(env, kind, "info", `${why}${note}`, `${text}${told}`);
	};

	let message = args.trim();
	if (!message) {
		const [stat, diff, recent] = await Promise.all([
			gitOut(env.cwd, ["diff", "--cached", "--stat", ...PLAIN_DIFF]),
			gitOut(env.cwd, ["diff", "--cached", ...PLAIN_DIFF]),
			gitOut(env.cwd, ["log", "-n", "8", "--format=%s"]),
		]);
		env.ui.notify("Writing a commit message…", "info");
		const drafted = await env.draft(commitPrompt({ branch: st.branch, stat: stat ?? "", diff: diff ?? "", recent: recent?.split("\n").filter(Boolean) ?? [] }));
		if (!drafted) env.ui.notify("Could not draft a message. Write one.", "warning");
		const edited = await env.ui.editor("Commit message", drafted ? cleanMessage(drafted) : "");
		if (edited === undefined) return dropCommit("cancelled", "Commit cancelled. Nothing was committed.", "cancelled at the message editor, nothing committed");
		message = edited.trim();
		if (!message) return dropCommit("nothing", "Empty message. Nothing was committed.", "empty message, nothing committed");
	}

	const r = await git(env.cwd, ["commit", "-F", "-"], { input: message, timeoutMs: 300_000 });
	if (r.code !== 0) return stop(env, "failed", "error", `git commit failed:\n${failure(r)}`, "git commit failed", keyLine(r));
	const sha = (await gitOut(env.cwd, ["rev-parse", "--short", "HEAD"])) ?? "";
	env.ui.notify(`Committed ${sha}: ${subject(message)}`, "info");
	return { kind: "done", text: `committed ${sha} ${quote(subject(message))}`, sha };
}

/** Where a push of the current branch goes, and how that compares with what the remote has. */
interface PushPlan {
	remote: string;
	branch: string;
	/** The remote branch pushed to, as "origin/feat". */
	target: string;
	/** The branch the local one tracks now, when that is not the target ("origin/main"). */
	otherUpstream?: string;
	/** False when the remote has no branch of that name yet. */
	published: boolean;
	ahead: number;
	behind: number;
}

/**
 * Decide where a push goes. The target is always the remote branch with the local branch's own
 * name. A branch made with `git checkout -b feat origin/main` tracks origin/main, and a bare
 * `git push` would then be refused (push.default=simple) or, worse, push the feature commits to
 * main (push.default=upstream), so the push names its destination and takes the target as the
 * new upstream. When there is no remote, the outcome to end with (after telling the user).
 */
async function planPush(env: Env, st: RepoStatus & { branch: string }): Promise<PushPlan | { stopped: Outcome }> {
	const remote = await remoteName(env.cwd, st.upstream ?? st.gone);
	if (!remote) return { stopped: stop(env, "blocked", "warning", "This repository has no remote to push to.", "the repository has no remote") };
	const target = `${remote}/${st.branch}`;
	if (st.upstream === target) return { remote, branch: st.branch, target, published: true, ahead: st.ahead, behind: st.behind };
	const otherUpstream = st.upstream;
	if (!(await refExists(env.cwd, `refs/remotes/${target}`))) return { remote, branch: st.branch, target, otherUpstream, published: false, ahead: 0, behind: 0 };
	const counts = await aheadBehind(env.cwd, `refs/remotes/${target}`);
	return { remote, branch: st.branch, target, otherUpstream, published: true, ahead: counts?.ahead ?? 0, behind: counts?.behind ?? 0 };
}

/** The question before a push, naming the exact remote branch it goes to. */
function pushQuestion(plan: PushPlan): string {
	const what = plan.published ? `Push ${plural(plan.ahead, "commit")} on ${plan.branch} to ${plan.target}?` : `Publish ${plan.branch} to ${plan.target}?`;
	if (!plan.otherUpstream) return what;
	return `${what}\n\n${plan.branch} tracks ${plan.otherUpstream} now. That branch is left alone; ${plan.target} becomes the upstream.`;
}

/** Push the current branch. Returns false when it did not happen (the reason is already shown). */
export async function push(env: Env, opts: { confirmed?: boolean } = {}): Promise<boolean> {
	const outcome = await reported(env, "push", () => pushBranch(env, opts));
	return outcome.kind === "done";
}

/** The push itself, without a report of its own, so /pr can report once for the whole command. */
async function pushBranch(env: Env, opts: { confirmed?: boolean }): Promise<Outcome> {
	const got = await status(env);
	if ("stopped" in got) return got.stopped;
	const st = got.st;
	if (!st.branch) return stop(env, "blocked", "warning", "HEAD is detached. Check out a branch to push.", "HEAD is detached");
	const plan = await planPush(env, { ...st, branch: st.branch });
	if ("stopped" in plan) return plan.stopped;
	const branchShown = clip(plan.branch);
	const targetShown = clip(plan.target);
	if (plan.behind) {
		return stop(env, "blocked", "warning", `${plan.branch} is ${plural(plan.behind, "commit")} behind ${plan.target}. Merge or rebase first. Nothing was pushed.`, `${branchShown} is ${plural(plan.behind, "commit")} behind ${targetShown}, nothing pushed`);
	}
	if (plan.published && !plan.ahead) {
		return stop(env, "nothing", "info", `Nothing to push: ${plan.branch} is up to date with ${plan.target}.`, `nothing to push, ${branchShown} is up to date with ${targetShown}`);
	}
	if (!opts.confirmed && !(await env.ui.confirm("Push", pushQuestion(plan)))) return { kind: "cancelled", text: "cancelled at the confirmation, nothing pushed" };
	// Named on both sides: never "whatever push.default says", and never another branch.
	const setsUpstream = plan.target !== st.upstream;
	const r = await git(env.cwd, ["push", ...(setsUpstream ? ["-u"] : []), plan.remote, `HEAD:refs/heads/${plan.branch}`], { timeoutMs: 300_000 });
	if (r.code !== 0) return stop(env, "failed", "error", `git push failed:\n${failure(r)}`, "git push failed, nothing pushed", keyLine(r));
	env.ui.notify(`${plan.published ? "Pushed" : "Published"} ${plan.branch} to ${plan.target}.`, "info");
	return { kind: "done", text: `${plan.published ? "pushed" : "published"} ${branchShown} to ${targetShown}${setsUpstream ? " and set it as the upstream" : ""}` };
}

export async function merge(env: Env, args: string): Promise<void> {
	await reported(env, "merge", () => runMerge(env, args));
}

async function runMerge(env: Env, args: string): Promise<Outcome> {
	const arg = args.trim();
	if (arg === "abort") {
		const r = await git(env.cwd, ["merge", "--abort"]);
		if (r.code === 0) return stop(env, "done", "info", "Merge aborted.", "merge aborted");
		return stop(env, "nothing", "warning", `Nothing to abort:\n${failure(r)}`, "nothing to abort", keyLine(r));
	}
	const got = await status(env);
	if ("stopped" in got) return got.stopped;
	const st = got.st;
	if (st.conflicted) return stop(env, "blocked", "warning", "There are unresolved conflicts. Resolve them and commit, or run /merge abort.", "unresolved conflicts");
	if (st.staged || st.unstaged) return stop(env, "blocked", "warning", "The working tree has uncommitted changes. Commit or stash them before merging.", "the working tree has uncommitted changes");
	const into = st.branch ?? (await currentBranch(env.cwd));
	if (!into) return stop(env, "blocked", "warning", "HEAD is detached. Check out the branch to merge into.", "HEAD is detached");

	let target = arg;
	if (!target) {
		const options = await localBranches(env.cwd, into);
		if (!options.length) return stop(env, "nothing", "info", "There are no other branches to merge.", "there are no other branches to merge");
		const picked = await env.ui.select(`Merge into ${into}`, options);
		if (!picked) return { kind: "cancelled", text: "cancelled at the branch choice, nothing merged" };
		target = picked;
	}
	const shown = clip(target);
	const intoShown = clip(into);
	if (!(await refExists(env.cwd, target))) return stop(env, "blocked", "warning", `No branch or ref named "${target}".`, `no branch or ref named ${quote(target)}`);
	const counted = await git(env.cwd, ["rev-list", "--count", `${into}..${target}`]);
	const count = Number(counted.stdout.trim());
	if (counted.code !== 0 || !Number.isFinite(count)) {
		return stop(env, "failed", "error", `Could not compare ${into} with ${target}:\n${failure(counted)}`, `could not compare ${intoShown} with ${shown}`, keyLine(counted));
	}
	if (!count) return stop(env, "nothing", "info", `Already up to date: ${into} contains everything in ${target}.`, `already up to date, ${intoShown} contains everything in ${shown}`);
	if (!(await env.ui.confirm("Merge", `Merge ${target} into ${into}? (${plural(count, "commit")})`))) return { kind: "cancelled", text: `cancelled at the confirmation, ${shown} was not merged` };

	const r = await git(env.cwd, ["merge", "--no-edit", target], { timeoutMs: 300_000 });
	if (r.code === 0) return stop(env, "done", "info", `Merged ${target} into ${into}.`, `merged ${shown} into ${intoShown}`);
	const conflicts = (await gitOut(env.cwd, ["diff", ...PLAIN_DIFF, "--name-only", "--diff-filter=U"]))?.split("\n").filter(Boolean) ?? [];
	if (conflicts.length) {
		const listed = conflicts.slice(0, 15).map((f) => `  ${f}`).join("\n");
		const more = conflicts.length > 15 ? `\n  …and ${conflicts.length - 15} more` : "";
		return stop(
			env,
			"failed",
			"warning",
			`Merge stopped on ${plural(conflicts.length, "conflict")}:\n${listed}${more}\nResolve them and commit, or run /merge abort.`,
			`merging ${shown} into ${intoShown} stopped on ${plural(conflicts.length, "conflict")}, the merge is in progress`,
		);
	}
	return stop(env, "failed", "error", `git merge failed:\n${failure(r)}`, "git merge failed", keyLine(r));
}

/** What /pr has done so far, for a report when it stops by an error. */
interface PrProgress {
	/** "pushed ...; " once the push inside /pr has happened. */
	pushedFirst: string;
}

export async function pullRequest(env: Env, args: string): Promise<void> {
	const progress: PrProgress = { pushedFirst: "" };
	await reported(env, "pr", () => runPullRequest(env, args, progress), () => progress.pushedFirst);
}

async function runPullRequest(env: Env, args: string, progress: PrProgress): Promise<Outcome> {
	const opts = parsePrArgs(args);
	const got = await status(env);
	if ("stopped" in got) return got.stopped;
	const st = got.st;
	if (!st.branch) return stop(env, "blocked", "warning", "HEAD is detached. Check out the branch to open a pull request from.", "HEAD is detached");
	if (st.conflicted) return stop(env, "blocked", "warning", "There are unresolved merge conflicts. Resolve them first.", "unresolved merge conflicts");
	const remote = await remoteName(env.cwd, st.upstream);
	if (!remote) return stop(env, "blocked", "warning", "This repository has no remote.", "the repository has no remote");

	const base = opts.base ?? (await defaultBranch(env.cwd, remote));
	if (!base) return stop(env, "blocked", "warning", "Could not tell the base branch. Pass it: /pr main", "could not tell the base branch");
	const shown = clip(base);
	const branchShown = clip(st.branch);
	if (base === st.branch) return stop(env, "blocked", "warning", `You are on ${base}, the base branch. Switch to a feature branch first.`, `on the base branch ${shown}`);
	const baseRef = await compareRef(env.cwd, remote, base);
	if (!baseRef) return stop(env, "blocked", "warning", `No branch named "${base}".`, `no branch named ${quote(base)}`);

	const commits = (await gitOut(env.cwd, ["log", `${baseRef}..HEAD`, "--format=%s"]))?.split("\n").filter(Boolean) ?? [];
	if (!commits.length) return stop(env, "nothing", "info", `${st.branch} has no commits that ${base} lacks. Nothing to open.`, `${branchShown} has no commits that ${shown} lacks`);
	if (st.staged || st.unstaged) env.ui.notify("Uncommitted changes are not part of the pull request.", "warning");

	const url = await gitOut(env.cwd, ["remote", "get-url", remote]);
	const host = url ? remoteHost(url) : undefined;
	const cli = await findForge(env.cwd, host);
	if (!cli) {
		return stop(
			env,
			"blocked",
			"warning",
			`Opening a pull request needs the gh or glab CLI, signed in${host ? ` to ${host}` : ""}. Run "gh auth login" or "glab auth login".`,
			`no gh or glab CLI signed in${host ? ` to ${clip(host)}` : ""}`,
		);
	}

	const plan = await planPush(env, { ...st, branch: st.branch });
	if ("stopped" in plan) return plan.stopped;
	if (plan.behind || !plan.published || plan.ahead) {
		// Behind is left to the push, which refuses and says why; otherwise name the exact target.
		if (!plan.behind) {
			const what = plan.published ? `${plural(plan.ahead, "commit")} on ${plan.branch} are not pushed` : `${plan.branch} is not published yet`;
			const tracks = plan.otherUpstream ? `\n\n${plan.branch} tracks ${plan.otherUpstream} now. That branch is left alone; ${plan.target} becomes the upstream.` : "";
			if (!(await env.ui.confirm("Push first", `${what}. Push to ${plan.target} and open the pull request?${tracks}`))) {
				return { kind: "cancelled", text: "cancelled at the push prompt, nothing pushed" };
			}
		}
		const pushed = await pushBranch(env, { confirmed: true });
		if (pushed.kind !== "done") return { ...pushed, text: `the push before the pull request: ${pushed.text}` };
		progress.pushedFirst = `${pushed.text}; `;
	}
	const before = progress.pushedFirst;

	const [stat, diff] = await Promise.all([gitOut(env.cwd, ["diff", "--stat", ...PLAIN_DIFF, `${baseRef}...HEAD`]), gitOut(env.cwd, ["diff", ...PLAIN_DIFF, `${baseRef}...HEAD`])]);
	env.ui.notify("Writing the pull request…", "info");
	const drafted = await env.draft(prPrompt({ base, branch: st.branch, commits, stat: stat ?? "", diff: diff ?? "" }));
	if (!drafted) env.ui.notify("Could not draft the description. Write it.", "warning");
	const fallback = commits.length === 1 ? commits[0]! : "";
	const edited = await env.ui.editor(`Pull request into ${base}${opts.draft ? " (draft)" : ""}: the first line is the title`, drafted ? cleanMessage(drafted) : fallback);
	if (edited === undefined) return stop(env, "cancelled", "info", "Pull request cancelled.", `${before}cancelled at the description editor`);
	const { title, body } = splitPr(edited);
	if (!title) return stop(env, "nothing", "info", "No title. Nothing was opened.", `${before}no title`);

	const r = await createRequest(env.cwd, cli, { base, head: st.branch, title, body, draft: opts.draft });
	const link = findUrl(`${r.stdout}\n${r.stderr}`);
	if (r.code === 0) {
		env.ui.notify(link ? `Opened: ${link}` : "Pull request opened.", "info");
		return { kind: "done", text: `${before}opened ${opts.draft ? "a draft " : "a "}pull request into ${shown}${link ? `: ${link}` : ""}`, url: link };
	}
	return stop(env, "failed", "error", `${cli} could not open the pull request:\n${failure(r)}`, `${before}${cli} could not open the pull request`, keyLine(r));
}
