/**
 * Unit tests for the pure parts: palette helpers, palette search,
 * peek phase machine, session-info diff stats, aws resolver, container detection.
 * Run: pnpm test  (node --experimental-strip-types --test test/*.test.ts)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { diffStats } from "../extensions/halo/session-info.ts";
import { fmtTokens, hasOwnColor, sanitize, sanitizeKeepColor } from "../extensions/halo/palette.ts";
import { filterPalette, fuzzyScore } from "../extensions/halo/commands.ts";
import { clipTail, lastLine, reducePeek } from "../extensions/halo/peek.ts";
import { accountFromAccessKeyId, registerCredentialProcessResolver, resolveAwsContext } from "../extensions/widgets/aws/resolve.ts";
import { containerLabel, detectContainer } from "../extensions/widgets/container/detect.ts";

test("sanitize strips control and escape sequences", () => {
	assert.equal(sanitize("a\x1b[31mb\x1b[0m\x1b]8;;http://x\x07c\nd"), "abc d");
	assert.equal(sanitize("\x1b[2Jhi\x07"), "hi");
});

test("sanitizeKeepColor keeps SGR colours only", () => {
	const s = sanitizeKeepColor("\x1b[31mred\x1b[2J");
	assert.ok(s.startsWith("\x1b[31mred"));
	assert.ok(!s.includes("\x1b[2J"));
	assert.ok(hasOwnColor(s));
	assert.ok(!hasOwnColor("\x1b[1mbold\x1b[22m"));
	assert.ok(hasOwnColor("\x1b[38;2;1;2;3mx"));
});

test("fmtTokens", () => {
	assert.equal(fmtTokens(999), "999");
	assert.equal(fmtTokens(1500), "1.5k");
	assert.equal(fmtTokens(38_000), "38k");
	assert.equal(fmtTokens(2_200_000), "2.2M");
});

test("diffStats counts added and removed lines, not headers", () => {
	assert.deepEqual(diffStats("--- a\n+++ b\n-old\n+new\n+more\n ctx"), { added: 2, removed: 1 });
	assert.deepEqual(diffStats(undefined), { added: 0, removed: 0 });
});

test("palette search: prefix beats subsequence, descriptions match last", () => {
	assert.equal(fuzzyScore("new", "/new"), 0);
	assert.ok((fuzzyScore("nw", "/new") ?? 99) > 1);
	assert.equal(fuzzyScore("zzz", "/new"), undefined);
	const items = [
		{ value: "/new", label: "/new", description: "Start a new session" },
		{ value: "/resume", label: "/resume", description: "Resume a different session" },
		{ value: "/model", label: "/model", description: "Select model" },
	];
	assert.deepEqual(filterPalette(items, "mod").map((i) => i.value), ["/model"]);
	assert.deepEqual(filterPalette(items, "session").map((i) => i.value), ["/new", "/resume"]);
	assert.equal(filterPalette(items, "").length, 3);
});

test("peek phase machine", () => {
	let s = { phase: "idle" as const, tail: "" } as ReturnType<typeof reducePeek>;
	s = reducePeek(s, { thinking: "", text: "hello" });
	assert.equal(s.phase, "idle");
	s = reducePeek(s, { thinking: "line one\nline two", text: "" });
	assert.equal(s.phase, "thinking");
	assert.equal(s.tail, "line two");
	s = reducePeek(s, { thinking: "line one\nline two", text: "answer" });
	assert.equal(s.phase, "done");
	s = reducePeek(s, { thinking: "more", text: "answer" });
	assert.equal(s.phase, "done");
	assert.equal(lastLine("a\n  b  c \n\n"), "b c");
	assert.equal(clipTail("abcdefgh", 5), "…efgh");
	assert.equal(clipTail("abc", 5), "abc");
});

test("aws resolver", () => {
	assert.equal(accountFromAccessKeyId("not-a-key"), undefined);
	const cfg = "[profile dev]\nrole_arn = arn:aws:iam::123456789012:role/Admin\nregion = us-west-2\n";
	const c = resolveAwsContext({ AWS_PROFILE: "dev" }, cfg);
	assert.equal(c?.account, "dev");
	assert.equal(c?.accountId, "123456789012");
	assert.equal(c?.role, "Admin");
	assert.equal(c?.region, "us-west-2");
	const sso = resolveAwsContext({ AWS_PROFILE: "s" }, "[profile s]\nsso_account_id = 111122223333\nsso_role_name = Dev\nregion = eu-west-1\n");
	assert.deepEqual([sso?.accountId, sso?.role, sso?.region], ["111122223333", "Dev", "eu-west-1"]);
	// A credential_process nobody claims is opaque: the profile name stands in for the account.
	const cfg2 = "[profile tool]\ncredential_process = mytool creds --acct prod\n";
	assert.equal(resolveAwsContext({ AWS_PROFILE: "tool" }, cfg2)?.account, "tool");
	assert.equal(resolveAwsContext({}, undefined), undefined);
});

test("container detection (moved from container-status.ts)", () => {
	const probe = (env: Record<string, string>, files: Record<string, string> = {}) => ({
		env,
		exists: (p: string) => p in files,
		read: (p: string) => files[p],
		hostname: () => "abc123.local",
	});
	assert.equal(detectContainer(probe({})), undefined);
	const dev = detectContainer(probe({ DEVCONTAINER: "true", DEVCONTAINER_NAME: "my-dev" }))!;
	assert.equal(containerLabel(dev), "my-dev");
	const docker = detectContainer(probe({}, { "/.dockerenv": "" }))!;
	assert.equal(containerLabel(docker), "docker:abc123");
	assert.equal(detectContainer(probe({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }))?.kind, "kubernetes");
});

test("hidden thinking-only messages render nothing once finished", async () => {
	const { isHiddenThoughtOnly } = await import("../extensions/halo/messages.ts");
	const msg = (content: unknown[], stopReason = "toolUse") => ({ content, stopReason });
	const base = { isStreaming: false, hideThinkingBlock: true, thinkingVisibilityOverrides: new Map() };
	const thought = { type: "thinking", thinking: "plan the edit" };
	const text = { type: "text", text: "Done." };
	assert.ok(isHiddenThoughtOnly({ ...base, lastMessage: msg([thought, { type: "toolCall" }]) }));
	assert.ok(!isHiddenThoughtOnly({ ...base, lastMessage: msg([thought, text]) }), "has an answer");
	assert.ok(!isHiddenThoughtOnly({ ...base, isStreaming: true, lastMessage: msg([thought]) }), "still streaming: peek shows");
	assert.ok(!isHiddenThoughtOnly({ ...base, hideThinkingBlock: false, lastMessage: msg([thought]) }), "thinking shown");
	assert.ok(!isHiddenThoughtOnly({ ...base, lastMessage: msg([thought], "error") }), "errors stay visible");
	assert.ok(!isHiddenThoughtOnly({ ...base, thinkingVisibilityOverrides: new Map([[0, false]]), lastMessage: msg([thought]) }), "clicked open");
	assert.ok(!isHiddenThoughtOnly({ ...base, lastMessage: msg([{ type: "thinking", thinking: "  " }]) }), "empty thinking");
});

test("home screen: tips parse, pi logo grid is 4x4", async () => {
	const { PI_PIXELS, TIPS, parseTip } = await import("../extensions/halo/home.ts");
	assert.deepEqual(parseTip("Press {tab} to cycle"), [
		{ text: "Press ", highlight: false },
		{ text: "tab", highlight: true },
		{ text: " to cycle", highlight: false },
	]);
	for (const t of TIPS) assert.ok(parseTip(t).some((p) => p.highlight), t);
	assert.equal(PI_PIXELS.length, 4);
	assert.ok(PI_PIXELS.every((r) => r.length === 4));
});

test("fmtAgo", async () => {
	const { fmtAgo } = await import("../extensions/halo/palette.ts");
	assert.equal(fmtAgo(10_000), "just now");
	assert.equal(fmtAgo(5 * 60_000), "5m ago");
	assert.equal(fmtAgo(3 * 3_600_000), "3h ago");
	assert.equal(fmtAgo(2 * 86_400_000), "2d ago");
	assert.equal(fmtAgo(30 * 86_400_000), "4w ago");
});

test("memoLines reuses restyled lines until pi's lines, width or style change", async () => {
	const { memoLines } = await import("../extensions/halo/messages.ts");
	const owner = {};
	let builds = 0;
	const build = (src: string[]) => () => (builds++, src.map((l) => `|${l}`));
	const a = ["one", "two"];
	const first = memoLines(owner, "s", 80, "k", a, build(a));
	assert.equal(memoLines(owner, "s", 80, "k", ["one", "two"], build(a)), first); // equal strings: cached
	assert.equal(builds, 1);
	memoLines(owner, "s", 80, "k", ["one", "three"], build(["one", "three"])); // content changed
	memoLines(owner, "s", 100, "k", ["one", "three"], build(["one", "three"])); // width changed
	memoLines(owner, "s", 100, "plan", ["one", "three"], build(["one", "three"])); // style changed
	assert.equal(builds, 4);
	assert.deepEqual(memoLines(owner, "s", 100, "plan", ["one", "three"], build([])), ["|one", "|three"]);
});

test("aws credential_process resolvers: first answer wins, errors are skipped, undo removes", () => {
	const cfg = "[profile tool]\ncredential_process = /opt/bin/mytool creds --acct prod\n";
	const env = { AWS_PROFILE: "tool", MYTOOL_REGION: "ap-south-1" };
	const offBroken = registerCredentialProcessResolver(() => {
		throw new Error("boom");
	});
	const offTool = registerCredentialProcessResolver((call) =>
		call.bin === "mytool" ? { account: call.args[call.args.indexOf("--acct") + 1], role: "Admin", region: call.env.MYTOOL_REGION } : undefined,
	);
	const c = resolveAwsContext(env, cfg);
	assert.deepEqual([c?.account, c?.role, c?.region, c?.source], ["prod", "Admin", "ap-south-1", "profile tool"]);
	// An explicit region beats the resolver's.
	assert.equal(resolveAwsContext({ ...env, AWS_REGION: "us-east-1" }, cfg)?.region, "us-east-1");
	offTool();
	offBroken();
	assert.equal(resolveAwsContext(env, cfg)?.account, "tool");
});
