/**
 * The pure text side of the git tools: the prompts sent to the model and cleaning what comes back.
 * No I/O, so it is tested directly.
 */

import { stripEscapes } from "../halo/sanitize.ts";

export const MAX_DIFF_CHARS = 30_000;

/** Cut a diff to `max` characters at a line boundary and say so, so the model knows it is partial. */
export function truncateDiff(diff: string, max = MAX_DIFF_CHARS): string {
	if (diff.length <= max) return diff;
	const cut = diff.slice(0, max);
	const lastNl = cut.lastIndexOf("\n");
	return `${lastNl > 0 ? cut.slice(0, lastNl) : cut}\n\n[diff truncated: ${diff.length - max} more characters not shown]`;
}

const COMMIT_SYSTEM = [
	"You write git commit messages.",
	"Reply with the commit message only: no code fences, no preamble, no quotes around it.",
	"First line: an imperative summary of 72 characters or fewer, no trailing period.",
	"If the change needs explanation, add a blank line and a short body that says why, wrapped at about 72 columns.",
	"Follow the style of the recent commits when one is evident (for example conventional commit prefixes), otherwise plain sentences.",
	"Describe only what the diff shows. Do not invent reasons, ticket numbers or features.",
].join("\n");

export interface CommitPromptInput {
	branch?: string;
	stat: string;
	diff: string;
	recent: string[];
}

export function commitPrompt(i: CommitPromptInput): { system: string; user: string } {
	const parts = [
		i.branch ? `Branch: ${i.branch}` : "",
		i.recent.length ? `Recent commit subjects (for style):\n${i.recent.map((s) => `- ${s}`).join("\n")}` : "",
		`Staged changes (summary):\n${i.stat.trim()}`,
		`Staged diff:\n${truncateDiff(i.diff)}`,
	];
	return { system: COMMIT_SYSTEM, user: parts.filter(Boolean).join("\n\n") };
}

const PR_SYSTEM = [
	"You write pull request titles and descriptions.",
	"Reply with the title on the first line, a blank line, then the description in Markdown. No code fences around the whole reply, no preamble.",
	"Title: imperative, 72 characters or fewer, no trailing period.",
	"Description: what changed and why, grouped sensibly, short. A brief bullet list is fine. Mention anything a reviewer should check or any risk visible in the diff.",
	"Describe only what the commits and diff show. Do not invent testing that was not shown, ticket numbers or features.",
].join("\n");

export interface PrPromptInput {
	base: string;
	branch: string;
	commits: string[];
	stat: string;
	diff: string;
}

export function prPrompt(i: PrPromptInput): { system: string; user: string } {
	const parts = [
		`Merging ${i.branch} into ${i.base}.`,
		`Commits (${i.commits.length}):\n${i.commits.map((c) => `- ${c}`).join("\n")}`,
		`Files changed:\n${i.stat.trim()}`,
		`Diff:\n${truncateDiff(i.diff)}`,
	];
	return { system: PR_SYSTEM, user: parts.join("\n\n") };
}

/** Strip what models add around a message: fences, a "Commit message:" label, wrapping quotes. */
export function cleanMessage(raw: string): string {
	let t = raw.replace(/\r/g, "").trim();
	const fenced = t.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
	if (fenced) t = fenced[1]!.trim();
	t = t.replace(/^(?:here(?:'s| is)[^\n:]*:|(?:commit message|message|title)\s*:)\s*/i, "").trim();
	if (/^(["'`]).*\1$/s.test(t) && !t.includes("\n")) t = t.slice(1, -1).trim();
	return t;
}

/** A PR draft as one editable text: the title, a blank line, the body. */
export function splitPr(text: string): { title: string; body: string } {
	const lines = cleanMessage(text).split("\n");
	const first = lines.findIndex((l) => l.trim());
	if (first < 0) return { title: "", body: "" };
	const title = lines[first]!.replace(/^#+\s*/, "").replace(/^title\s*:\s*/i, "").trim();
	return { title, body: lines.slice(first + 1).join("\n").trim() };
}

/** The first line of a message. */
export const subject = (message: string): string => message.split("\n", 1)[0]?.trim() ?? "";

/** Arguments of /pr: an optional base branch and a --draft flag, in any order. */
export function parsePrArgs(args: string): { base?: string; draft: boolean } {
	let draft = false;
	let base: string | undefined;
	for (const word of args.split(/\s+/).filter(Boolean)) {
		if (word === "--draft" || word === "-d") draft = true;
		else if (!word.startsWith("-")) base ??= word;
	}
	return { base, draft };
}

/**
 * Command output made safe to show in a notification: escape sequences (colours, cursor moves,
 * window titles) and other control characters are dropped, a tab becomes spaces, and a line that
 * was redrawn with carriage returns (a progress bar) keeps only its last version. Newlines stay.
 */
export function plainText(raw: string): string {
	const withoutEscapes = stripEscapes(raw);
	return withoutEscapes
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.split("\r").reverse().find((part) => part !== "") ?? "")
		.join("\n")
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "");
}

const AUTH_FAILURE = [
	/could not read (?:username|password)/i,
	/terminal prompts disabled/i,
	/authentication (?:failed|required)|requires authentication|invalid username or password/i,
	/permission denied \(publickey/i,
	/enter passphrase|incorrect passphrase/i,
	/(?:HTTP|error:?|status)\s*40[13]\b/i,
	/gpg failed to sign|pinentry|no secret key/i,
	/not logged in|(?:gh|glab) auth login/i,
];

/** True when command output reads like a missing sign-in, key passphrase or gpg unlock. */
export const looksLikeAuthFailure = (text: string): boolean => AUTH_FAILURE.some((re) => re.test(text));

export const AUTH_HINT = "Hint: sign in with your credential helper, or unlock your key in ssh-agent or gpg-agent, from another terminal first, then try again.";
