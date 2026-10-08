/**
 * Git side of the diff view: parsing unified diff text, and loading the two things the panel can
 * show from a repository.
 *
 *   changes  everything not yet committed: staged, unstaged and untracked files in one list, with
 *            git status's two-letter code for each (`M `, ` M`, `MM`, `??`)
 *   branch   what the current branch changed since it left its base branch (`main...HEAD`; the
 *            base is the remote's default branch, as /pr finds it)
 *
 * All git commands are run with execFile and an argument array, never through a shell, and with
 * --no-optional-locks so looking never blocks the user's own git.
 */

import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareRef, defaultBranch, remoteName } from "../git/repo.ts";
import { PLAIN_DIFF } from "../git/run.ts";

export interface DiffLine {
	kind: "add" | "del" | "ctx" | "note";
	text: string;
	oldNo?: number;
	newNo?: number;
}

export interface Hunk {
	/** The `@@ -a,b +c,d @@ context` line. */
	header: string;
	lines: DiffLine[];
	/** The hunk's lines exactly as git wrote them, header first. */
	raw: string[];
}

export interface FileDiff {
	path: string;
	oldPath?: string;
	/** Two characters for the file list: git status's XY for changes, "M " style for a branch. */
	code: string;
	status: "A" | "M" | "D" | "R";
	binary: boolean;
	added: number;
	removed: number;
	/** The lines before the first hunk (`diff --git`, `index`, `---`, `+++`). */
	header: string[];
	hunks: Hunk[];
	/** Why there is no text to show (too large, a symlink, unreadable). */
	note?: string;
}

export interface Loaded {
	files: FileDiff[];
	/** A message to show in place of an empty list, or under a full one. */
	note?: string;
	/** A failure to show instead of the list. */
	error?: string;
	/** Dim text next to the source tabs, e.g. "main...HEAD · 3 commits". */
	meta?: string;
	/** What the branch source compares against ("origin/develop"); the Branch tab names it. */
	base?: string;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

const cleanPath = (p: string): string => p.replace(/\t.*$/, "").replace(/^[ab]\//, "");

/**
 * Parse unified diff text (`git diff`, or `diff -u` with `---`/`+++` headers) into files and hunks.
 * A hunk ends when its line counts from the `@@` header are used up, so a blank context line that
 * lost its leading space does not end it early. A line that starts with `@@ ` or `diff --git `
 * ends it too, whatever the counts say: a body line always starts with a space, `+`, `-` or `\`,
 * so this makes a diff with wrong counts (from a hand-built or model-written patch) still split
 * into the right hunks and files.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
	const files: FileDiff[] = [];
	const all = text.split("\n");
	if (all[all.length - 1] === "") all.pop();
	let f: FileDiff | undefined;
	let h: Hunk | undefined;
	let oldLeft = 0;
	let newLeft = 0;
	let oldNo = 0;
	let newNo = 0;
	let pendingOld: { path: string; raw: string } | undefined;
	const start = (path: string): FileDiff => {
		const n: FileDiff = { path, code: "M ", status: "M", binary: false, added: 0, removed: 0, header: [], hunks: [] };
		files.push(n);
		return n;
	};

	for (const line of all) {
		const startsNew = line.startsWith("@@ ") || line.startsWith("diff --git ");
		if (h && f && !startsNew && (oldLeft > 0 || newLeft > 0 || line.startsWith("\\"))) {
			h.raw.push(line);
			if (line.startsWith("\\")) {
				h.lines.push({ kind: "note", text: line.slice(2) });
				continue;
			}
			const c = line[0] ?? " ";
			const body = line.slice(1);
			if (c === "+") {
				h.lines.push({ kind: "add", text: body, newNo: newNo++ });
				newLeft--;
				f.added++;
			} else if (c === "-") {
				h.lines.push({ kind: "del", text: body, oldNo: oldNo++ });
				oldLeft--;
				f.removed++;
			} else {
				h.lines.push({ kind: "ctx", text: body, oldNo: oldNo++, newNo: newNo++ });
				oldLeft--;
				newLeft--;
			}
			continue;
		}
		h = undefined;

		if (line.startsWith("diff --git ")) {
			const rest = line.slice(11);
			const same = /^a\/(.+) b\/\1$/.exec(rest);
			f = start(same ? same[1]! : (rest.split(" b/").pop() ?? rest));
			f.header.push(line);
			pendingOld = undefined;
			continue;
		}
		const m = HUNK.exec(line);
		if (m) {
			f ??= start("(diff)");
			h = { header: line, lines: [], raw: [line] };
			f.hunks.push(h);
			oldNo = Number(m[1]);
			newNo = Number(m[3]);
			oldLeft = m[2] === undefined ? 1 : Number(m[2]);
			newLeft = m[4] === undefined ? 1 : Number(m[4]);
			continue;
		}
		const inGitHeader = f !== undefined && f.hunks.length === 0 && f.header.length > 0;
		if (line.startsWith("--- ")) {
			if (inGitHeader) f!.header.push(line);
			else pendingOld = { path: cleanPath(line.slice(4)), raw: line };
			continue;
		}
		if (line.startsWith("+++ ")) {
			if (inGitHeader) {
				f!.header.push(line);
			} else {
				const p = cleanPath(line.slice(4));
				f = start(p === "/dev/null" ? (pendingOld?.path ?? "(diff)") : p);
				if (pendingOld) f.header.push(pendingOld.raw);
				f.header.push(line);
				pendingOld = undefined;
			}
			continue;
		}
		if (!f || f.hunks.length > 0) continue;
		f.header.push(line);
		if (line.startsWith("new file mode")) f.status = "A";
		else if (line.startsWith("deleted file mode")) f.status = "D";
		else if (line.startsWith("rename from ")) {
			f.oldPath = line.slice(12);
			f.status = "R";
		} else if (line.startsWith("rename to ")) f.path = line.slice(10);
		else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) f.binary = true;
	}
	for (const file of files) file.code = `${file.status} `;
	return files;
}

// ---- running git -------------------------------------------------------------------------------

const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 32 << 20;
// PLAIN_DIFF forces the a/ b/ prefixes the parser expects, whatever diff.noprefix or
// diff.mnemonicPrefix say in the user's config.
const DIFF_FLAGS = [...PLAIN_DIFF, "-M", "--unified=3"];

interface GitResult {
	ok: boolean;
	out: string;
	err: string;
}

function git(args: string[], cwd: string): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["--no-optional-locks", "-c", "core.quotepath=off", ...args],
			{ cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8" },
			(err, out, errOut) => {
				const message = err ? (String(errOut ?? "").trim().split("\n")[0] || err.message).slice(0, 200) : "";
				resolve({ ok: !err, out: String(out ?? ""), err: message });
			},
		);
	});
}

async function repoRoot(cwd: string): Promise<{ root: string } | { error: string }> {
	const top = await git(["rev-parse", "--show-toplevel"], cwd);
	if (top.ok) return { root: top.out.trim() };
	return { error: /not a git repository/i.test(top.err) ? "Not a git repository" : top.err || "git failed" };
}

export interface StatusEntry {
	xy: string;
	path: string;
	orig?: string;
}

/** Parse `git status --porcelain=v1 -z`. A rename or copy is followed by its origin as its own entry. */
export function parseStatus(out: string): StatusEntry[] {
	const parts = out.split("\0");
	const entries: StatusEntry[] = [];
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;
		if (p.length < 4) continue;
		const xy = p.slice(0, 2);
		const entry: StatusEntry = { xy, path: p.slice(3) };
		if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") entry.orig = parts[++i];
		entries.push(entry);
	}
	return entries;
}

const statusLetter = (xy: string): FileDiff["status"] => {
	if (xy.includes("R")) return "R";
	if (xy.includes("D")) return "D";
	if (xy.includes("A") || xy === "??") return "A";
	return "M";
};

const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 256 * 1024;

/** A new file as the diff git would show if it were added: every line an addition. */
async function untrackedDiff(root: string, path: string): Promise<FileDiff> {
	const header = [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`];
	const empty = (): FileDiff => {
		const f = parseUnifiedDiff(header.join("\n"))[0]!;
		f.code = "??";
		return f;
	};
	const full = join(root, path);
	try {
		const st = await lstat(full);
		if (!st.isFile()) {
			const f = empty();
			f.note = st.isSymbolicLink() ? "symlink" : "not a regular file";
			return f;
		}
		if (st.size > MAX_UNTRACKED_BYTES) {
			const f = empty();
			f.note = `${Math.round(st.size / 1024)} KB, too large to show`;
			return f;
		}
		const buf = await readFile(full);
		if (buf.subarray(0, 8000).includes(0)) {
			const f = empty();
			f.binary = true;
			return f;
		}
		const text = buf.toString("utf8");
		const lines = text.split("\n");
		const endsWithNewline = text.endsWith("\n");
		if (endsWithNewline) lines.pop();
		if (lines.length === 0) return empty();
		const body = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)];
		if (!endsWithNewline) body.push("\\ No newline at end of file");
		const f = parseUnifiedDiff([...header, ...body].join("\n"))[0]!;
		f.code = "??";
		return f;
	} catch {
		const f = empty();
		f.note = "unreadable";
		return f;
	}
}

/** Staged, unstaged and untracked changes in one list, like `git status` with the diffs attached. */
export async function loadChanges(cwd: string): Promise<Loaded> {
	const repo = await repoRoot(cwd);
	if ("error" in repo) return { files: [], error: repo.error };
	const { root } = repo;
	const [status, head] = await Promise.all([
		git(["status", "--porcelain=v1", "-z", "-uall"], root),
		git(["rev-parse", "--verify", "--quiet", "HEAD"], root),
	]);
	if (!status.ok) return { files: [], error: status.err || "git status failed" };

	const byPath = new Map<string, FileDiff>();
	if (head.ok) {
		const d = await git(["diff", "HEAD", ...DIFF_FLAGS], root);
		if (!d.ok) return { files: [], error: d.err || "git diff failed" };
		for (const f of parseUnifiedDiff(d.out)) byPath.set(f.path, f);
	} else {
		// No commits yet: there is no HEAD to compare with, so take the index and the working tree
		// separately. A file in both shows what is staged.
		const [cached, worktree] = await Promise.all([git(["diff", "--cached", ...DIFF_FLAGS], root), git(["diff", ...DIFF_FLAGS], root)]);
		for (const f of parseUnifiedDiff(worktree.out)) byPath.set(f.path, f);
		for (const f of parseUnifiedDiff(cached.out)) byPath.set(f.path, f);
	}

	const files: FileDiff[] = [];
	const untracked: string[] = [];
	for (const e of parseStatus(status.out)) {
		if (e.xy === "??") {
			untracked.push(e.path);
			continue;
		}
		const f: FileDiff = byPath.get(e.path) ?? {
			path: e.path,
			oldPath: e.orig,
			code: e.xy,
			status: statusLetter(e.xy),
			binary: false,
			added: 0,
			removed: 0,
			header: [],
			hunks: [],
		};
		f.code = e.xy;
		if (e.orig) f.oldPath ??= e.orig;
		files.push(f);
		byPath.delete(e.path);
	}
	for (const f of byPath.values()) {
		f.code = " M";
		files.push(f);
	}
	for (const path of untracked.slice(0, MAX_UNTRACKED_FILES)) files.push(await untrackedDiff(root, path));
	files.sort((a, b) => a.path.localeCompare(b.path));
	const skipped = untracked.length - MAX_UNTRACKED_FILES;
	return { files, note: skipped > 0 ? `${skipped} more untracked files not shown` : undefined };
}

/**
 * The branch to compare against and the ref to compare with, found the way /pr finds its base: the
 * remote's default branch, else main or master on the remote, else main or master here. The
 * remote's copy is preferred over a local one, which may be stale.
 */
async function findBase(root: string): Promise<{ branch: string; ref: string } | undefined> {
	const remote = (await remoteName(root)) ?? "origin";
	const branch = await defaultBranch(root, remote);
	if (!branch) return undefined;
	const ref = await compareRef(root, remote, branch);
	return ref ? { branch, ref } : undefined;
}

/** What the current branch changed since it left its base: `git diff <base>...HEAD`. */
export async function loadBranch(cwd: string): Promise<Loaded> {
	const repo = await repoRoot(cwd);
	if ("error" in repo) return { files: [], error: repo.error };
	const { root } = repo;
	if (!(await git(["rev-parse", "--verify", "--quiet", "HEAD"], root)).ok) return { files: [], note: "No commits yet." };
	const base = await findBase(root);
	if (!base) return { files: [], note: "Could not find a base branch to compare against: the remote names no default branch, and there is no main or master." };
	const current = await git(["symbolic-ref", "--short", "-q", "HEAD"], root);
	if (current.ok && current.out.trim() === base.branch) return { files: [], meta: base.ref, base: base.ref, note: `You are on ${base.branch}. Switch to a branch to see how it differs.` };
	const [d, count] = await Promise.all([git(["diff", ...DIFF_FLAGS, `${base.ref}...HEAD`], root), git(["rev-list", "--count", `${base.ref}..HEAD`], root)]);
	if (!d.ok) return { files: [], error: d.err || "git diff failed" };
	const files = parseUnifiedDiff(d.out);
	files.sort((a, b) => a.path.localeCompare(b.path));
	const n = Number(count.out.trim()) || 0;
	return { files, base: base.ref, meta: `${base.ref}...HEAD · ${n} commit${n === 1 ? "" : "s"}`, note: files.length ? undefined : `No changes against ${base.ref}.` };
}
