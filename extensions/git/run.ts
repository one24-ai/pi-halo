/**
 * Run a program without a shell: arguments are an array, so branch names, messages and paths never
 * need quoting and cannot inject anything. Never throws: a failure is a non-zero `code`.
 *
 * Programs run with no way to ask you anything. A child that keeps pi's controlling terminal can
 * open /dev/tty and draw an ssh passphrase, credential or gpg prompt over pi's screen, then wait
 * for a key pi will never forward. So on POSIX the child gets its own session (no controlling
 * terminal), git is told not to prompt, and a prompt fails at once with a message instead of
 * hanging until the timeout. stdin stays a pipe, so `commit -F -` and `gh --body-file -` work.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { AUTH_HINT, looksLikeAuthFailure, plainText } from "./text.ts";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	timeoutMs?: number;
	/** Written to the program's stdin. */
	input?: string;
	env?: Record<string, string>;
}

/** Exit code reported when the program had to be stopped for running too long (as timeout(1) does). */
export const TIMED_OUT = 124;
const KILL_GRACE_MS = 2000;
const MAX_OUTPUT = 32 << 20;

/** The environment for a child: prompts off, and no pointer to pi's terminal for gpg to draw on. */
function childEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...extra };
	delete env.GPG_TTY;
	return env;
}

/**
 * Children run detached (their own process group, no controlling terminal), so they would not get
 * the terminal's signals if pi is closed. Track them and stop their groups when pi exits.
 */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;
function track(child: ChildProcess, group: boolean): void {
	if (!group) return;
	live.add(child);
	child.once("close", () => live.delete(child));
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const c of live) stop(c, "SIGTERM", true);
	});
}

/** Stop the child and anything it started: a hook or credential helper can have children of its own. */
function stop(child: ChildProcess, signal: NodeJS.Signals, group: boolean): void {
	try {
		if (group && child.pid) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		// already gone
	}
}

export function run(cmd: string, args: string[], cwd: string, opts: RunOptions = {}): Promise<RunResult> {
	return new Promise((resolve) => {
		const timeoutMs = opts.timeoutMs ?? 60_000;
		const posix = process.platform !== "win32";
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let size = 0;
		let tooBig = false;
		let timedOut = false;
		let spawnError: NodeJS.ErrnoException | undefined;
		let timer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;

		const child = spawn(cmd, args, { cwd, env: childEnv(opts.env), detached: posix, stdio: ["pipe", "pipe", "pipe"] });
		track(child, posix);
		const collect = (into: Buffer[]) => (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_OUTPUT) {
				tooBig = true;
				return stop(child, "SIGKILL", posix);
			}
			into.push(chunk);
		};
		child.stdout.on("data", collect(out));
		child.stderr.on("data", collect(err));
		child.on("error", (e) => void (spawnError = e));
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			const stdout = Buffer.concat(out).toString("utf8");
			const stderr = Buffer.concat(err).toString("utf8");
			if (spawnError) {
				const missing = spawnError.code === "ENOENT";
				return resolve({ code: missing ? 127 : 1, stdout, stderr: missing ? `${cmd}: command not found` : spawnError.message });
			}
			if (timedOut) {
				const note = `${cmd} did not finish in ${Math.round(timeoutMs / 1000)} seconds and was stopped.`;
				return resolve({ code: TIMED_OUT, stdout, stderr: stderr ? `${stderr.trimEnd()}\n${note}` : note });
			}
			if (tooBig) return resolve({ code: 1, stdout, stderr: `${cmd} printed more than ${MAX_OUTPUT >> 20} MB and was stopped.` });
			if (code === 0) return resolve({ code: 0, stdout, stderr });
			resolve({ code: code ?? 1, stdout, stderr: stderr || (signal ? `${cmd} was stopped by ${signal}` : `${cmd} failed`) });
		});
		timer = setTimeout(() => {
			timedOut = true;
			stop(child, "SIGTERM", posix);
			killTimer = setTimeout(() => stop(child, "SIGKILL", posix), KILL_GRACE_MS);
		}, timeoutMs);
		child.stdin.on("error", () => {});
		child.stdin.end(opts.input ?? "");
	});
}

/**
 * Flags for a git diff whose output is parsed or sent to the model: no colour, no external diff
 * program, and a/ b/ prefixes whatever diff.noprefix or diff.mnemonicPrefix says.
 */
export const PLAIN_DIFF = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];

export const git = (cwd: string, args: string[], opts?: RunOptions): Promise<RunResult> => run("git", args, cwd, opts);

/** stdout of a git command, trimmed; undefined when it failed. */
export async function gitOut(cwd: string, args: string[]): Promise<string | undefined> {
	const r = await git(cwd, args);
	return r.code === 0 ? r.stdout.trim() : undefined;
}

/**
 * The useful part of a failed command, for a notification. Output from git, hooks and gh is
 * cleaned of escape sequences first, so it cannot move the cursor or retitle the window, and a
 * failure that reads like a missing sign-in gets a one-line hint.
 */
export function failure(r: RunResult, max = 1200): string {
	const text = plainText(r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).trim() || `exit ${r.code}`;
	const shown = text.length > max ? `${text.slice(0, max)}…` : text;
	return looksLikeAuthFailure(text) ? `${shown}\n${AUTH_HINT}` : shown;
}
