/**
 * Git diff view: parsing, loading from real repositories, drawing, keys and mouse, and the host API
 * other extensions use.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatWidgetList, widgetInfo } from "../extensions/halo/api.ts";
import { resetBrand, setBrand } from "../extensions/halo/brand.ts";
import { loadBranch, loadChanges, parseStatus, parseUnifiedDiff } from "../extensions/diff/git-diff.ts";
import { addDiffAction, diffHost, openDiff } from "../extensions/diff/host.ts";
import { buildBody, clean, cutLeft, paletteFor, renderBodyRow, renderFileRow } from "../extensions/diff/render.ts";
import type { Loaded } from "../extensions/diff/git-diff.ts";
import { DiffView, layoutFor, TWO_PANE_MIN } from "../extensions/diff/view.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const theme = {
	getColorMode: () => "truecolor",
	getFgAnsi: (n: string) => ({ toolDiffAdded: "\x1b[38;2;80;200;120m", toolDiffRemoved: "\x1b[38;2;240;80;80m" })[n] ?? "\x1b[38;2;200;200;200m",
	getBgAnsi: () => "\x1b[48;2;60;20;30m",
} as any;

// ---- parsing -----------------------------------------------------------------------------------

const GIT_DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 111..222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,3 +1,3 @@ function one()",
	" keep",
	"-old",
	"+new",
	" tail",
	"@@ -20,2 +20,3 @@",
	" ctx",
	"+added",
	" ctx2",
	"diff --git a/new.txt b/new.txt",
	"new file mode 100644",
	"--- /dev/null",
	"+++ b/new.txt",
	"@@ -0,0 +1,2 @@",
	"+one",
	"+two",
	"\\ No newline at end of file",
].join("\n");

test("parseUnifiedDiff: files, hunks, counts, line numbers and the no-newline note", () => {
	const files = parseUnifiedDiff(GIT_DIFF);
	assert.deepEqual(files.map((f) => [f.path, f.status, f.added, f.removed, f.hunks.length]), [["src/a.ts", "M", 2, 1, 2], ["new.txt", "A", 2, 0, 1]]);
	const h = files[0]!.hunks[0]!;
	assert.equal(h.header, "@@ -1,3 +1,3 @@ function one()");
	assert.deepEqual(h.lines.map((l) => [l.kind, l.oldNo, l.newNo]), [["ctx", 1, 1], ["del", 2, undefined], ["add", undefined, 2], ["ctx", 3, 3]]);
	assert.equal(h.raw.length, 5, "the header and four lines, exactly as git wrote them");
	assert.deepEqual(files[1]!.hunks[0]!.lines.map((l) => l.kind), ["add", "add", "note"]);
});

test("parseUnifiedDiff: a removed line that starts with -- or a blank context line does not end the hunk", () => {
	const text = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,4 +1,3 @@", " a", "--- a dash line", "", "-c", "+d"].join("\n");
	const f = parseUnifiedDiff(text)[0]!;
	assert.equal(f.hunks.length, 1);
	assert.deepEqual(f.hunks[0]!.lines.map((l) => l.kind), ["ctx", "del", "ctx", "del", "add"]);
	assert.equal(f.removed, 2);
});

test("parseUnifiedDiff: wrong counts in the @@ header still split into the right hunks and files", () => {
	const text = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,9 +1,9 @@", " a", "-b", "+c", "@@ -20,9 +20,9 @@", " d", "-e", "+f", "diff --git a/y b/y", "--- a/y", "+++ b/y", "@@ -1 +1 @@", "-p", "+q"].join("\n");
	const files = parseUnifiedDiff(text);
	assert.deepEqual(files.map((f) => [f.path, f.hunks.length, f.added, f.removed]), [["x", 2, 2, 2], ["y", 1, 1, 1]]);
	assert.ok(files[0]!.hunks.every((h) => h.lines.every((l) => !l.text.startsWith("@@") && !l.text.startsWith("diff"))), "no header line was taken for content");
});

test("parseUnifiedDiff: plain diff -u output with no diff --git line, two files", () => {
	const text = ["--- a/one.txt\t2026-01-01", "+++ b/one.txt\t2026-01-02", "@@ -1 +1 @@", "-x", "+y", "--- a/two.txt", "+++ b/two.txt", "@@ -1 +1 @@", "-p", "+q"].join("\n");
	const files = parseUnifiedDiff(text);
	assert.deepEqual(files.map((f) => f.path), ["one.txt", "two.txt"]);
	assert.deepEqual(files.map((f) => [f.added, f.removed]), [[1, 1], [1, 1]]);
});

test("parseUnifiedDiff: rename, delete and binary", () => {
	const text = [
		"diff --git a/old.txt b/new.txt", "similarity index 100%", "rename from old.txt", "rename to new.txt",
		"diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
		"diff --git a/img.png b/img.png", "index 1..2 100644", "Binary files a/img.png and b/img.png differ",
	].join("\n");
	const [r, d, b] = parseUnifiedDiff(text);
	assert.deepEqual([r!.path, r!.oldPath, r!.status], ["new.txt", "old.txt", "R"]);
	assert.deepEqual([d!.status, d!.removed], ["D", 1]);
	assert.equal(b!.binary, true);
});

test("parseUnifiedDiff: empty and junk input give no files and do not throw", () => {
	assert.deepEqual(parseUnifiedDiff(""), []);
	assert.deepEqual(parseUnifiedDiff("not a diff\nat all\n"), []);
});

test("parseStatus: -z entries, with a rename followed by its origin", () => {
	const out = ["M  a.txt", "?? b c.txt", "R  new.txt", "old.txt", " D gone.txt", ""].join("\0");
	assert.deepEqual(parseStatus(out), [{ xy: "M ", path: "a.txt" }, { xy: "??", path: "b c.txt" }, { xy: "R ", path: "new.txt", orig: "old.txt" }, { xy: " D", path: "gone.txt" }]);
});

// ---- real repositories -------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function repo(): string {
	const d = mkdtempSync(join(tmpdir(), "halo-diff-"));
	roots.push(d);
	const run = (...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "pipe" });
	run("init", "-q", "-b", "main");
	run("config", "user.email", "t@t");
	run("config", "user.name", "t");
	return d;
}
const sh = (d: string, ...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "pipe" });
const put = (d: string, name: string, text: string) => {
	mkdirSync(join(d, name, ".."), { recursive: true });
	writeFileSync(join(d, name), text);
};

test("loadChanges: staged, unstaged, untracked, deleted and renamed files in one sorted list", async () => {
	const d = repo();
	put(d, "a.txt", "1\n2\n3\n");
	put(d, "del.txt", "bye\n");
	put(d, "mv.txt", "same\n");
	put(d, "both.txt", Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
	sh(d, "add", "."); sh(d, "commit", "-q", "-m", "init");
	put(d, "a.txt", "1\nTWO\n3\n"); // unstaged
	sh(d, "rm", "-q", "del.txt");
	sh(d, "mv", "mv.txt", "moved.txt");
	const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
	lines[1] = "L2 staged";
	put(d, "both.txt", lines.join("\n") + "\n"); sh(d, "add", "both.txt");
	lines[17] = "L18 unstaged";
	put(d, "both.txt", lines.join("\n") + "\n"); // staged and unstaged
	put(d, "sub/new.txt", "fresh\nfile"); // untracked, no trailing newline
	const l = await loadChanges(d);
	assert.equal(l.error, undefined);
	assert.deepEqual(l.files.map((f) => [f.path, f.code]), [["a.txt", " M"], ["both.txt", "MM"], ["del.txt", "D "], ["moved.txt", "R "], ["sub/new.txt", "??"]]);
	const both = l.files.find((f) => f.path === "both.txt")!;
	assert.equal(both.hunks.length, 2, "staged and unstaged edits show together, against HEAD");
	const fresh = l.files.find((f) => f.path === "sub/new.txt")!;
	assert.deepEqual([fresh.added, fresh.hunks[0]!.lines.at(-1)!.kind], [2, "note"], "an untracked file is all additions, with the no-newline note");
	assert.equal(l.files.find((f) => f.path === "moved.txt")!.oldPath, "mv.txt");
});

test("loadChanges: a repository with no commits, and a directory that is not a repository", async () => {
	const d = repo();
	put(d, "first.txt", "hello\n"); sh(d, "add", "first.txt");
	put(d, "loose.txt", "x\n");
	const l = await loadChanges(d);
	assert.deepEqual(l.files.map((f) => [f.path, f.code, f.added]), [["first.txt", "A ", 1], ["loose.txt", "??", 1]]);
	const plain = mkdtempSync(join(tmpdir(), "halo-nogit-"));
	roots.push(plain);
	assert.equal((await loadChanges(plain)).error, "Not a git repository");
	assert.equal((await loadBranch(plain)).error, "Not a git repository");
});

test("loadChanges: untracked binary, symlink and oversized files are listed with a note, not read", async () => {
	const d = repo();
	put(d, "seed.txt", "s\n"); sh(d, "add", "."); sh(d, "commit", "-q", "-m", "i");
	writeFileSync(join(d, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
	symlinkSync("/etc/passwd", join(d, "link"));
	writeFileSync(join(d, "huge.txt"), "x".repeat(300 * 1024));
	const files = (await loadChanges(d)).files;
	const by = (n: string) => files.find((f) => f.path === n)!;
	assert.equal(by("blob.bin").binary, true);
	assert.equal(by("link").note, "symlink", "a symlink is not followed");
	assert.match(by("huge.txt").note!, /too large/);
	assert.equal(by("huge.txt").hunks.length, 0);
});

test("loadChanges and loadBranch: diff.noprefix, diff.mnemonicPrefix and diff.external in the user's config do not break the paths", async () => {
	for (const setting of ["diff.noprefix", "diff.mnemonicPrefix"]) {
		const d = repo();
		put(d, "src/a.txt", "1\n2\n"); sh(d, "add", "."); sh(d, "commit", "-q", "-m", "init");
		sh(d, "config", setting, "true");
		sh(d, "config", "diff.external", "false"); // an external diff program must not be used
		put(d, "src/a.txt", "1\nTWO\n");
		put(d, "src/b.txt", "new\n"); sh(d, "add", "src/b.txt");
		const changes = await loadChanges(d);
		assert.equal(changes.error, undefined, setting);
		assert.deepEqual(changes.files.map((f) => [f.path, f.code, f.added, f.removed]), [["src/a.txt", " M", 1, 1], ["src/b.txt", "A ", 1, 0]], setting);
		sh(d, "checkout", "-q", "-b", "feature");
		sh(d, "add", "-A"); sh(d, "commit", "-q", "-m", "work");
		sh(d, "branch", "-f", "main", "HEAD~1");
		const branch = await loadBranch(d);
		assert.deepEqual(branch.files.map((f) => [f.path, f.status]), [["src/a.txt", "M"], ["src/b.txt", "A"]], `${setting} on the branch tab`);
	}
});

test("loadBranch: the base is the remote's default branch, as /pr finds it (develop, trunk), and the tab says which", async () => {
	for (const name of ["develop", "trunk", "main"]) {
		const d = repo();
		const remote = mkdtempSync(join(tmpdir(), "halo-diff-remote-"));
		roots.push(remote);
		execFileSync("git", ["init", "-q", "--bare", "-b", name], { cwd: remote });
		sh(d, "checkout", "-q", "-b", name);
		put(d, "base.txt", "base\n"); sh(d, "add", "."); sh(d, "commit", "-q", "-m", "base");
		sh(d, "remote", "add", "origin", remote);
		sh(d, "push", "-q", "-u", "origin", name);
		sh(d, "remote", "set-head", "origin", name);
		sh(d, "checkout", "-q", "-b", "feature");
		put(d, "f.txt", "one\n"); sh(d, "add", "."); sh(d, "commit", "-q", "-m", "one");
		const l = await loadBranch(d);
		assert.equal(l.error, undefined, name);
		assert.deepEqual(l.files.map((f) => f.path), ["f.txt"], name);
		assert.equal(l.base, `origin/${name}`);
		assert.equal(l.meta, `origin/${name}...HEAD · 1 commit`);
	}
});

test("loadBranch: a stale local main is not used when the remote has a newer one", async () => {
	const d = repo();
	const remote = mkdtempSync(join(tmpdir(), "halo-diff-remote-"));
	roots.push(remote);
	execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
	put(d, "base.txt", "base\n"); sh(d, "add", "."); sh(d, "commit", "-q", "-m", "base");
	sh(d, "remote", "add", "origin", remote);
	sh(d, "push", "-q", "-u", "origin", "main");
	sh(d, "remote", "set-head", "origin", "main");
	// origin/main moves on (somebody else merged), and this clone's local main never follows
	put(d, "merged.txt", "m\n"); sh(d, "add", "."); sh(d, "commit", "-q", "-m", "merged upstream");
	sh(d, "push", "-q", "origin", "main");
	sh(d, "checkout", "-q", "-b", "feature");
	put(d, "f.txt", "one\n"); sh(d, "add", "."); sh(d, "commit", "-q", "-m", "one");
	sh(d, "branch", "-f", "main", "HEAD~2"); // local main is two commits behind
	const l = await loadBranch(d);
	assert.deepEqual(l.files.map((f) => f.path), ["f.txt"], "only the feature's own change, not what was merged upstream");
	assert.equal(l.base, "origin/main");
});

test("loadBranch: a repository with no remote still compares against a local main or master", async () => {
	for (const name of ["main", "master"]) {
		const d = repo();
		sh(d, "branch", "-m", name);
		put(d, "base.txt", "base\n"); sh(d, "add", "."); sh(d, "commit", "-q", "-m", "base");
		sh(d, "checkout", "-q", "-b", "feature");
		put(d, "f.txt", "one\n"); sh(d, "add", "."); sh(d, "commit", "-q", "-m", "one");
		const l = await loadBranch(d);
		assert.equal(l.base, name);
		assert.equal(l.meta, `${name}...HEAD · 1 commit`);
	}
});

test("loadBranch: the commits since main, the count, and the main-branch and detached cases", async () => {
	const d = repo();
	put(d, "base.txt", "base\n"); sh(d, "add", "."); sh(d, "commit", "-q", "-m", "base");
	let l = await loadBranch(d);
	assert.match(l.note!, /You are on main/);
	sh(d, "checkout", "-q", "-b", "feature");
	put(d, "f.txt", "one\n"); sh(d, "add", "."); sh(d, "commit", "-q", "-m", "one");
	put(d, "g.txt", "two\n"); sh(d, "add", "."); sh(d, "commit", "-q", "-m", "two");
	put(d, "uncommitted.txt", "not in the branch diff\n");
	l = await loadBranch(d);
	assert.deepEqual(l.files.map((f) => f.path), ["f.txt", "g.txt"], "committed work only");
	assert.equal(l.meta, "main...HEAD · 2 commits");
	sh(d, "checkout", "-q", "--detach");
	assert.equal((await loadBranch(d)).files.length, 2, "a detached HEAD still compares");
	sh(d, "branch", "-m", "main", "trunk"); // no main or master left
	assert.match((await loadBranch(d)).note!, /no main or master/i);
});

// ---- drawing -----------------------------------------------------------------------------------

test("clean: escape sequences, C1 controls and bidi overrides never reach the screen", () => {
	const dirty = "a\x1b[31mred\x1b[0m\x1b]0;title\x07 b\u202eevil\u009b1m\tz";
	const out = clean(dirty);
	assert.ok(!/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u202a-\u202e]/.test(out), JSON.stringify(out));
	assert.ok(out.includes("red") && out.includes("    z"), "the text is kept, tabs become four spaces");
});

test("rows are exactly the width asked for, with wide characters, long lines and shifting", () => {
	const pal = paletteFor(theme);
	const rows = [
		{ kind: "add" as const, text: "x".repeat(300), newNo: 7 },
		{ kind: "del" as const, text: "日本語のテキスト and more", oldNo: 12 },
		{ kind: "ctx" as const, text: "", oldNo: 3, newNo: 3 },
		{ kind: "hunk" as const, text: "@@ -1,2 +1,2 @@ " + "y".repeat(200) },
		{ kind: "note" as const, text: "Binary file" },
		{ kind: "blank" as const, text: "" },
	];
	for (const w of [1, 5, 20, 60, 120]) {
		for (const r of rows) {
			for (const shift of [0, 8]) assert.equal(visibleWidth(renderBodyRow(r, w, pal, 3, shift)), w, `${r.kind} at ${w}`);
		}
	}
	for (const path of ["a.ts", "very/long/directory/structure/that/goes/on/and/on/file.ts", "日本語/ファイル.ts"]) {
		for (const w of [8, 30, 44]) {
			const f = { path, code: "MM", status: "M" as const, binary: false, added: 12, removed: 3, header: [], hunks: [] };
			assert.equal(visibleWidth(renderFileRow(f, w, pal, true)), w, `${path} at ${w}`);
			assert.equal(visibleWidth(renderFileRow(f, w, pal, false, false)), w);
		}
	}
	assert.equal(cutLeft("abcdefghij/klm.ts", 8), "…/klm.ts".slice(0, 8));
	assert.ok(visibleWidth(cutLeft("abcdefghij/klm.ts", 8)) <= 8);
});

test("added and removed lines are tinted across the row, context lines are not", () => {
	const pal = paletteFor(theme);
	assert.notEqual(pal.addBg, pal.panel);
	assert.notEqual(pal.delBg, pal.panel);
	assert.ok(renderBodyRow({ kind: "add", text: "x", newNo: 1 }, 30, pal, 3).startsWith(pal.addBg));
	assert.ok(renderBodyRow({ kind: "del", text: "x", oldNo: 1 }, 30, pal, 3).startsWith(pal.delBg));
	assert.ok(renderBodyRow({ kind: "ctx", text: "x", oldNo: 1, newNo: 1 }, 30, pal, 3).startsWith(pal.panel));
});

/** The RGB of a background escape sequence. */
const rgbOf = (bg: string): [number, number, number] => {
	const m = /\x1b\[48;2;(\d+);(\d+);(\d+)m/.exec(bg)!;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
};

test("the tints have the hue of their colour, also on a panel shade with a colour cast (#121312 is slightly green)", () => {
	// A pure grey has no hue, so mixing in OKLCH looks fine on it; a grey with a cast has one, and
	// the mix then slid from green through yellow, giving an olive line where a red one belongs.
	const brands: (string | undefined)[] = [undefined, "#121312", "#131218", "#181212"];
	for (const panel of brands) {
	resetBrand();
	if (panel) setBrand({ surfaces: { panel } });
	for (const [removed, added] of [["255;70;85", "29;243;181"], ["240;80;80", "80;200;120"], ["220;50;47", "46;160;67"]]) {
		const t = {
			getColorMode: () => "truecolor",
			getFgAnsi: (n: string) => (n === "toolDiffRemoved" ? `\x1b[38;2;${removed}m` : n === "toolDiffAdded" ? `\x1b[38;2;${added}m` : "\x1b[38;2;200;200;200m"),
			getBgAnsi: () => "\x1b[48;2;60;20;30m",
		} as any;
		const pal = paletteFor(t);
		const [dr, dg, db] = rgbOf(pal.delBg);
		assert.ok(dr > dg + 10 && dr > db + 10, `removed (${removed}) on panel ${panel ?? "default"} is reddish, got ${dr},${dg},${db}`);
		const [ar, ag, ab] = rgbOf(pal.addBg);
		assert.ok(ag > ar + 10 && ag >= ab - 12, `added (${added}) is greenish, got ${ar},${ag},${ab}`);
		for (const c of [dr, dg, db, ar, ag, ab]) assert.ok(c < 90, "a tint, not a fill: text stays readable");
	}
	}
	resetBrand();
});

test("buildBody: a hunk header per hunk, rows in order, and a note for files with no text", () => {
	const [a, n] = parseUnifiedDiff(GIT_DIFF);
	const body = buildBody(a!);
	assert.equal(body.hunkStarts.length, 2);
	assert.equal(body.rows[body.hunkStarts[1]!]!.kind, "hunk");
	assert.equal(body.rows[body.hunkStarts[1]! - 1]!.kind, "blank", "a blank row between hunks");
	assert.equal(body.numWidth, 3);
	assert.equal(buildBody({ ...n!, hunks: [], binary: true }).rows[0]!.text, "Binary file");
	assert.match(buildBody({ ...n!, hunks: [], note: "symlink" }).rows[0]!.text, /symlink/);
});

// ---- the view ----------------------------------------------------------------------------------

const tick = () => new Promise((r) => setImmediate(r));
const PATCH = (name: string, hunks: number) =>
	[`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`]
		.concat(Array.from({ length: hunks }, (_, i) => [`@@ -${i * 40 + 1},2 +${i * 40 + 1},2 @@`, " a", `-old ${i}`, `+new ${i}`].join("\n").split("\n")).flat())
		.join("\n");
const sampleFiles = () => parseUnifiedDiff([PATCH("a.ts", 3), PATCH("b.ts", 1), PATCH("c.ts", 1)].join("\n"));

function harness(opts: { changes?: Loaded; branch?: Loaded; cols?: number; rows?: number; external?: boolean; actions?: any[] } = {}) {
	const tui = { terminal: { rows: opts.rows ?? 30, columns: opts.cols ?? 120 }, requestRender() { this.renders++; }, renders: 0 } as any;
	const calls: string[] = [];
	const closed = { n: 0 };
	const notes: string[] = [];
	const view = new DiffView({
		tui, theme, cwd: "/repo",
		ctx: { ui: { notify: (m: string) => notes.push(m) } } as any,
		actions: () => opts.actions ?? [],
		done: () => void closed.n++,
		load: async (s) => (calls.push(s), (s === "changes" ? opts.changes : opts.branch) ?? { files: [] }),
		external: opts.external ? { title: "ext", files: sampleFiles() } : undefined,
	});
	const text = () => view.render(tui.terminal.columns).map(strip);
	return { view, tui, calls, closed, notes, text };
}
const click = (x: number, y: number) => ({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 120, height: 30, shift: false, alt: false, ctrl: false }) as any;
const wheel = (x: number, y: number, d: number) => ({ type: "wheel", button: "none", x, y, screenX: x, screenY: y, width: 120, height: 30, wheelDelta: d, shift: false, alt: false, ctrl: false }) as any;

test("the view loads on open, shows the list and the first file's diff, and every row is exactly the width", async () => {
	const h = harness({ changes: { files: sampleFiles() } });
	assert.match(h.text().join("\n"), /Loading/);
	await tick();
	const t = h.text();
	assert.equal(t.length, 30);
	for (const w of [TWO_PANE_MIN - 1, TWO_PANE_MIN, 160, 60, 30]) {
		h.tui.terminal.columns = w;
		for (const l of h.view.render(w)) assert.equal(visibleWidth(l), w, `width ${w}`);
	}
	h.tui.terminal.columns = 120;
	const screen = h.text().join("\n");
	assert.match(screen, /Changes.*Branch/);
	assert.match(screen, /3 files/);
	assert.match(screen, /a\.ts/);
	assert.match(screen, /@@ -1,2 \+1,2 @@/);
	assert.match(screen, /- old 0/);
	assert.deepEqual(h.calls, ["changes"], "git is read once, not on a timer");
});

test("keys: j and k move the file selection, enter opens the diff pane, h goes back, q and esc close", async () => {
	const h = harness({ changes: { files: sampleFiles() } });
	await tick();
	h.text();
	h.view.handleInput("j");
	assert.match(h.text().find((l) => l.startsWith("▌"))!, /b\.ts/);
	h.view.handleInput("k"); h.view.handleInput("k");
	assert.match(h.text().find((l) => l.startsWith("▌"))!, /a\.ts/, "the selection stops at the top");
	h.view.handleInput("G");
	assert.match(h.text().find((l) => l.startsWith("▌"))!, /c\.ts/);
	h.view.handleInput("g");
	h.view.handleInput("\r"); // enter
	h.view.handleInput("j"); // now scrolls the diff, not the list
	assert.match(h.text().find((l) => l.startsWith("▌"))!, /a\.ts/, "the file did not change");
	h.view.handleInput("h");
	h.view.handleInput("j");
	assert.match(h.text().find((l) => l.startsWith("▌"))!, /b\.ts/, "back in the list");
	h.view.handleInput("q");
	h.view.handleInput("\x1b");
	assert.equal(h.closed.n, 2);
});

test("hunks: ] and [ move between them, the current one is marked, and the footer counts them", async () => {
	const h = harness({ changes: { files: sampleFiles() }, rows: 12 });
	await tick();
	const marked = () => h.text().filter((l) => l.includes("▌ @@")).length;
	const hunkNo = () => Number(/hunk (\d)\/3/.exec(h.text().at(-1)!)?.[1]);
	assert.equal(hunkNo(), 1);
	assert.equal(marked(), 1);
	h.view.handleInput("]");
	assert.equal(hunkNo(), 2);
	h.view.handleInput("]"); h.view.handleInput("]");
	assert.equal(hunkNo(), 3, "stops at the last hunk");
	assert.equal(marked(), 1, "exactly one hunk is marked, and it is in view");
	h.view.handleInput("[");
	assert.equal(hunkNo(), 2);
	h.view.handleInput("j"); // in the list: moves the file, and the hunk position resets
	assert.equal(hunkNo() || 0, 0, "b.ts has one hunk, so no counter is shown");
});

test("tab and the tabs switch source; the branch list loads once and is kept", async () => {
	const h = harness({ changes: { files: sampleFiles() }, branch: { files: parseUnifiedDiff(PATCH("only.ts", 1)), meta: "main...HEAD · 2 commits" } });
	await tick();
	h.view.handleInput("\t");
	await tick();
	let screen = h.text().join("\n");
	assert.match(screen, /only\.ts/);
	assert.match(screen, /main\.\.\.HEAD · 2 commits/);
	h.view.handleInput("\t");
	h.view.handleInput("\t");
	await tick();
	assert.deepEqual(h.calls, ["changes", "branch"], "each source is read once");
	h.view.handleInput("r");
	await tick();
	assert.deepEqual(h.calls, ["changes", "branch", "branch"], "r reads the current source again");
	screen = h.text().join("\n");
	assert.match(screen, /only\.ts/);
});

test("reload keeps the selected file when it is still there", async () => {
	const files = sampleFiles();
	let now = { files };
	const tui = { terminal: { rows: 30, columns: 120 }, requestRender() {} } as any;
	const view = new DiffView({ tui, theme, cwd: "/", ctx: {} as any, actions: () => [], done() {}, load: async () => now });
	await tick();
	view.render(120);
	view.handleInput("j");
	now = { files: [files[2]!, files[1]!] }; // a.ts gone, order changed
	view.handleInput("r");
	await tick();
	assert.match(view.render(120).map(strip).find((l) => l.startsWith("▌"))!, /b\.ts/);
});

test("the mouse: clicking a file selects it, clicking a tab switches, the wheel scrolls the diff", async () => {
	const h = harness({ changes: { files: sampleFiles() }, branch: { files: parseUnifiedDiff(PATCH("only.ts", 1)) }, rows: 10 });
	await tick();
	h.text();
	h.view.handleMouse(click(5, 3)); // list row 2 (y=1 is the first file)
	assert.match(h.text().find((l) => l.startsWith("▌"))!, /c\.ts/);
	h.view.handleMouse(click(5, 1));
	assert.match(h.text().find((l) => l.startsWith("▌"))!, /a\.ts/);
	const before = h.text().join("\n");
	h.view.handleMouse(wheel(60, 4, 1)); // over the diff pane
	assert.notEqual(h.text().join("\n"), before, "the diff scrolled");
	h.view.handleMouse(click(25, 0)); // the Branch tab
	await tick();
	assert.match(h.text().join("\n"), /only\.ts/);
	assert.deepEqual(h.view.handleMouse(click(70, 5)), { handled: true }, "mouse events are always consumed");
});

test("below the two-pane width the list and the diff take turns", async () => {
	const h = harness({ changes: { files: sampleFiles() }, cols: 70 });
	await tick();
	assert.equal(layoutFor(70, 30).two, false);
	let screen = h.text().join("\n");
	assert.match(screen, /a\.ts/);
	assert.doesNotMatch(screen, /@@ -1,2/, "only the list");
	h.view.handleInput("\r");
	screen = h.text().join("\n");
	assert.match(screen, /@@ -1,2 \+1,2 @@/);
	assert.doesNotMatch(screen, /b\.ts/, "only the diff");
	h.view.handleInput("\x1b"); // esc goes back to the list first
	assert.equal(h.closed.n, 0);
	assert.match(h.text().join("\n"), /b\.ts/);
	h.view.handleInput("\x1b");
	assert.equal(h.closed.n, 1);
});

test("empty and error states say so", async () => {
	const cases: [Loaded, RegExp][] = [[{ files: [], note: "No changes against main." }, /No changes against main/], [{ files: [] }, /No changes/], [{ files: [], error: "Not a git repository" }, /Not a git repository/]];
	for (const [loaded, want] of cases) {
		const h = harness({ changes: loaded });
		await tick();
		assert.match(h.text().join("\n"), want);
		for (const l of h.view.render(120)) assert.equal(visibleWidth(l), 120);
	}
	const bad = new DiffView({ tui: { terminal: { rows: 20, columns: 100 }, requestRender() {} } as any, theme, cwd: "/", ctx: {} as any, actions: () => [], done() {}, load: async () => { throw new Error("boom\nsecond line"); } });
	await tick();
	assert.match(bad.render(100).map(strip).join("\n"), /boom/);
});

test("a result that arrives after the panel closed is ignored", async () => {
	let release!: (l: Loaded) => void;
	const tui = { terminal: { rows: 20, columns: 100 }, requestRender() { this.n++; }, n: 0 } as any;
	const view = new DiffView({ tui, theme, cwd: "/", ctx: {} as any, actions: () => [], done() {}, load: () => new Promise<Loaded>((r) => (release = r)) });
	view.dispose();
	const n = tui.n;
	release({ files: sampleFiles() });
	await tick();
	assert.equal(tui.n, n, "no repaint after close");
});

test("actions: the menu lists them, enter closes the panel first and runs the action with the file and hunk", async () => {
	const seen: any[] = [];
	const order: string[] = [];
	const action = { id: "x", label: "Send to reviewer", run: (c: any) => void (order.push("run"), seen.push(c)) };
	const h = harness({ changes: { files: sampleFiles() }, actions: [action, { id: "bad", label: "Explodes", run: () => { throw new Error("nope"); } }], rows: 14 });
	(h.view as any).d.done = () => order.push("closed");
	await tick();
	h.text();
	h.view.handleInput("\r"); // open diff pane
	h.view.handleInput("]"); // second hunk of a.ts
	h.view.handleInput("a");
	const menu = h.text().join("\n");
	assert.match(menu, /Actions/);
	assert.match(menu, /Send to reviewer/);
	h.view.handleInput("\r");
	await tick();
	assert.deepEqual(order, ["closed", "run"], "the panel is closed before the action runs");
	const c = seen[0];
	assert.equal(c.file.path, "a.ts");
	assert.equal(c.source, "changes");
	assert.equal(c.hunk.index, 1, "the hunk the cursor is on");
	assert.equal(c.hunk.header, "@@ -41,2 +41,2 @@");
	assert.match(c.hunk.text, /^@@ -41,2 \+41,2 @@\n a\n-old 1\n\+new 1\n$/);
	assert.match(c.filePatch, /^diff --git a\/a\.ts b\/a\.ts\n--- a\/a\.ts\n\+\+\+ b\/a\.ts\n@@ -1,2/);
	// a throwing action is reported, not raised
	const h2 = harness({ changes: { files: sampleFiles() }, actions: [{ id: "bad", label: "Explodes", run: () => { throw new Error("nope\nmore"); } }] });
	await tick();
	h2.text();
	h2.view.handleInput("a");
	h2.view.handleInput("\r");
	await tick();
	await tick();
	assert.deepEqual(h2.notes, ["Explodes: nope"]);
});

test("the action menu: esc closes it, a click picks an item, and with no actions `a` says so", async () => {
	const ran: string[] = [];
	const actions = [{ id: "1", label: "First", run: () => void ran.push("1") }, { id: "2", label: "Second", run: () => void ran.push("2") }];
	const h = harness({ changes: { files: sampleFiles() }, actions });
	await tick();
	h.text();
	h.view.handleInput("a");
	h.view.handleInput("\x1b");
	assert.doesNotMatch(h.text().join("\n"), /Actions/);
	assert.equal(h.closed.n, 0, "esc only closed the menu");
	h.view.handleInput("a");
	const lines = h.text();
	const y = lines.findIndex((l) => l.includes("Second"));
	const x = lines[y]!.indexOf("Second");
	h.view.handleMouse(click(x, y));
	await tick();
	assert.deepEqual(ran, ["2"]);
	const none = harness({ changes: { files: sampleFiles() } });
	await tick();
	none.text();
	none.view.handleInput("a");
	assert.match(none.text().at(-1)!, /No actions/);
	assert.doesNotMatch(none.text().at(-1)!, /a actions/, "the hint is hidden when there is nothing to show");
});

test("an external diff shows its title, has no source tabs, and actions see source 'external'", async () => {
	let got: any;
	const h = harness({ external: true, actions: [{ id: "x", label: "Act", run: (c: any) => void (got = c) }] });
	const screen = h.text().join("\n");
	assert.match(screen, /ext/);
	assert.doesNotMatch(screen, /Branch/);
	assert.deepEqual(h.calls, [], "nothing is read from git");
	h.view.handleInput("\t"); // no effect
	h.view.handleInput("a");
	h.view.handleInput("\r");
	await tick();
	assert.equal(got.source, "external");
});

// ---- the host ----------------------------------------------------------------------------------

test("addDiffAction: replaces by id, is removable, and is shared through globalThis", () => {
	const host = diffHost();
	const before = host.actions.length;
	const off1 = addDiffAction({ id: "t1", label: "One", run() {} });
	const off2 = addDiffAction({ id: "t1", label: "One again", run() {} });
	assert.equal(host.actions.length, before + 1);
	assert.equal(host.actions.find((a) => a.id === "t1")!.label, "One again");
	assert.equal((globalThis as any)[Symbol.for("pi-halo/diff")], host, "one store, found by symbol");
	off1(); // the first registration was replaced, so this removes nothing
	assert.equal(host.actions.length, before + 1);
	off2();
	assert.equal(host.actions.length, before);
});

test("openDiff: false when the diff view is not loaded, the host's answer when it is", async () => {
	const host = diffHost();
	host.open = undefined;
	assert.equal(await openDiff({} as any, { title: "t", diff: "" }), false);
	const seen: any[] = [];
	host.open = async (_c, req) => (seen.push(req), true);
	assert.equal(await openDiff({} as any, { title: "t", diff: "--- a\n+++ b\n" }), true);
	assert.equal(seen[0].title, "t");
	host.open = undefined;
});

test("/widgets list shows the diff view's row as a command when it has no slot", async () => {
	const { registerWidget } = await import("../extensions/halo/api.ts");
	registerWidget({ on: () => () => {} } as any, { id: "diff-test", slots: [], render: () => undefined });
	const text = formatWidgetList(widgetInfo().filter((w) => w.id === "diff-test"));
	assert.match(text, /diff-test \[ok\] · command/);
});

// ---- opening on a given file (sidebar click-through) -------------------------------------------

test("the file option selects that file once the load finishes, by relative or absolute path", async () => {
	for (const file of ["b.ts", "/repo/b.ts", "sub/../b.ts"]) {
		const tui = { terminal: { rows: 30, columns: 120 }, requestRender() {} } as any;
		const view = new DiffView({ tui, theme, cwd: "/repo", ctx: {} as any, actions: () => [], done() {}, load: async () => ({ files: sampleFiles() }), file });
		await tick();
		assert.match(view.render(120).map(strip).find((l) => l.startsWith("▌"))!, /b\.ts/, file);
	}
});

test("the file option applies to the first load only: a reload keeps where the user moved to", async () => {
	const tui = { terminal: { rows: 30, columns: 120 }, requestRender() {} } as any;
	const view = new DiffView({ tui, theme, cwd: "/repo", ctx: {} as any, actions: () => [], done() {}, load: async () => ({ files: sampleFiles() }), file: "b.ts" });
	await tick();
	view.handleInput("j"); // b.ts to c.ts
	view.handleInput("r");
	await tick();
	assert.match(view.render(120).map(strip).find((l) => l.startsWith("▌"))!, /c\.ts/);
});

test("the file option falls back to the first file when it is not among the changes", async () => {
	const tui = { terminal: { rows: 30, columns: 120 }, requestRender() {} } as any;
	const view = new DiffView({ tui, theme, cwd: "/repo", ctx: {} as any, actions: () => [], done() {}, load: async () => ({ files: sampleFiles() }), file: "nope.ts" });
	await tick();
	assert.match(view.render(120).map(strip).find((l) => l.startsWith("▌"))!, /a\.ts/);
});

test("the file option matches a repo root above the session directory", async () => {
	const tui = { terminal: { rows: 30, columns: 120 }, requestRender() {} } as any;
	// git lists paths from the repo root ("src/b.ts"); the session runs in /repo/app.
	const files = parseUnifiedDiff([PATCH("a.ts", 1), PATCH("app/b.ts", 1)].join("\n"));
	const view = new DiffView({ tui, theme, cwd: "/repo/app", ctx: {} as any, actions: () => [], done() {}, load: async () => ({ files }), file: "b.ts" });
	await tick();
	assert.match(view.render(120).map(strip).find((l) => l.startsWith("▌"))!, /b\.ts/);
});

test("openChanges reports false when the diff view is not loaded, and passes the file on when it is", async () => {
	const host = diffHost();
	const saved = host.openChanges;
	host.openChanges = undefined;
	const { openChanges } = await import("../extensions/diff/host.ts");
	assert.equal(await openChanges({} as any, "a.ts"), false);
	const seen: unknown[] = [];
	host.openChanges = async (_c, f) => (seen.push(f), true);
	assert.equal(await openChanges({} as any, "a.ts"), true);
	assert.deepEqual(seen, ["a.ts"]);
	host.openChanges = saved;
});

test("openDiff and openChanges pass on false when the host showed nothing", async () => {
	const host = diffHost();
	const savedOpen = host.open;
	const savedOpenChanges = host.openChanges;
	const { openChanges } = await import("../extensions/diff/host.ts");
	host.open = async () => false;
	host.openChanges = async () => false;
	assert.equal(await openDiff({} as any, { title: "t", diff: "" }), false);
	assert.equal(await openChanges({} as any), false);
	host.open = savedOpen;
	host.openChanges = savedOpenChanges;
});

test("the diff extension reports false when nothing was shown: no UI, view switched off, already open; true after a real show", async () => {
	const { default: install } = await import("../extensions/diff/index.ts");
	const { getRegistry } = await import("../extensions/halo/api.ts");
	const host = diffHost();
	const savedOpen = host.open;
	const savedOpenChanges = host.openChanges;
	install({ on: () => () => {}, registerCommand() {} } as any);
	const notes: string[] = [];
	let release!: () => void;
	let shown = 0;
	const ctx = (over: object = {}) => ({
		hasUI: true,
		mode: "tui",
		cwd: "/repo",
		ui: { notify: (m: string) => notes.push(m), custom: async () => (shown++, new Promise<void>((r) => (release = r))) },
		...over,
	}) as any;
	const req = { title: "t", diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n" };

	assert.equal(await host.open!(ctx({ hasUI: false }), req), false, "no UI");
	assert.equal(await host.openChanges!(ctx({ hasUI: false })), false, "no UI");
	assert.equal(await host.open!(ctx({ mode: "print" }), req), false, "a mode that cannot draw the panel");
	assert.equal(shown, 0);

	getRegistry().disabled.add("diff");
	assert.equal(await host.open!(ctx(), req), false, "switched off");
	assert.equal(await host.openChanges!(ctx()), false, "switched off");
	assert.match(notes.at(-1)!, /switched off/);
	getRegistry().disabled.delete("diff");

	const first = host.open!(ctx(), req);
	await tick();
	assert.equal(shown, 1);
	assert.equal(await host.open!(ctx(), req), false, "already open");
	assert.equal(await host.openChanges!(ctx()), false, "already open");
	assert.equal(shown, 1);
	release();
	assert.equal(await first, true, "true once the panel was shown and closed");

	const second = host.openChanges!(ctx(), "x");
	await tick();
	release();
	assert.equal(await second, true);
	host.open = savedOpen;
	host.openChanges = savedOpenChanges;
});

// ---- CRLF, narrow screens, short screens -------------------------------------------------------

test("a CRLF file shows no dot at the end of each line", () => {
	assert.equal(clean("line one\r"), "line one");
	assert.equal(clean("a\rb"), "a·b", "a carriage return in the middle is still a control character");
	const files = parseUnifiedDiff(["diff --git a/w.txt b/w.txt", "--- a/w.txt", "+++ b/w.txt", "@@ -1,2 +1,2 @@", " keep\r", "-old\r", "+new\r"].join("\n"));
	const body = buildBody(files[0]!);
	assert.deepEqual(body.rows.filter((r) => r.kind !== "hunk").map((r) => r.text), ["keep", "old", "new"]);
	const shown = renderBodyRow(body.rows[3]!, 40, paletteFor(theme), 3);
	assert.ok(!strip(shown).includes("·"), strip(shown));
});

test("every row fits the width down to one column, and the panel never makes a row wider than asked", async () => {
	const actions = [{ id: "1", label: "First action", run() {} }, { id: "2", label: "Second", run() {} }];
	for (const cols of [1, 2, 3, 5, 9, 10, 20]) {
		for (const mode of ["list", "diff", "menu"]) {
			const h = harness({ changes: { files: sampleFiles() }, cols, rows: 12, actions });
			await tick();
			h.view.render(cols);
			if (mode === "diff") h.view.handleInput("\r");
			if (mode === "menu") h.view.handleInput("a");
			const rows = h.view.render(cols);
			for (const r of rows) assert.equal(visibleWidth(r), cols, `${mode} at ${cols} columns`);
			assert.equal(rows.length, 12, `${mode} at ${cols} columns`);
		}
	}
	const empty = harness({ changes: { files: [], error: "Not a git repository" }, cols: 4, rows: 8 });
	await tick();
	for (const r of empty.view.render(4)) assert.equal(visibleWidth(r), 4);
});

test("the action menu never writes more rows than the screen has, and scrolls to keep the selection in view", async () => {
	const ran: string[] = [];
	const actions = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, label: `Action ${i}`, run: () => void ran.push(`a${i}`) }));
	for (const rows of [4, 5, 6, 8, 30]) {
		const h = harness({ changes: { files: sampleFiles() }, actions, rows });
		await tick();
		h.text();
		h.view.handleInput("a");
		const before = h.view.render(120).length;
		assert.equal(before, Math.max(4, rows), `the screen keeps its height at ${rows} rows`);
		const text = h.text();
		assert.equal(text.length, Math.max(4, rows));
		assert.match(text[0]!, /Diff/, "the header is not overwritten");
		assert.match(text.at(-1)!, /esc|actions|hunk|%|close/, "the footer is not overwritten");
		for (let i = 0; i < 11; i++) h.view.handleInput("j");
		assert.match(h.text().join("\n"), /Action 11/, `the last item scrolls into view at ${rows} rows`);
		assert.equal(h.view.render(120).length, Math.max(4, rows));
	}
	// clicking an item in a scrolled menu runs the one that was drawn there
	const h = harness({ changes: { files: sampleFiles() }, actions, rows: 6 });
	await tick();
	h.text();
	h.view.handleInput("a");
	for (let i = 0; i < 8; i++) h.view.handleInput("j");
	const lines = h.text();
	const y = lines.findIndex((l) => l.includes("Action 8"));
	assert.ok(y > 0);
	h.view.handleMouse(click(lines[y]!.indexOf("Action 8"), y));
	await tick();
	assert.deepEqual(ran, ["a8"]);
});

test("diff view text drops escape sequences and bidi marks from file contents", async () => {
	const { clean } = await import("../extensions/diff/render.ts");
	const out = clean("a\x1b]52;c;aGk=\x07b\x1b[2Jc\u202ed\u200fe\u061cf");
	assert.equal(out, "abcdef");
});
