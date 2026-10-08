/**
 * The bash filter behind Plan mode: decides whether a command line looks read-only.
 *
 * It is a strict allow-list, not a deny-list. The line is split into words the way bash would
 * (quotes, escapes, operators), anything that can hide a second command or a write is rejected
 * outright (command substitution, subshells, heredocs, redirects other than to /dev/null), and
 * every pipeline segment must then start with a command on the list below, with the flags that let
 * that command write or run other programs rejected. When unsure it blocks.
 *
 * This is a guardrail against a model wandering off, not a sandbox. Build and test commands
 * (cargo check, pnpm run test) run project code and write caches or build output, and the
 * filter accepts that on purpose.
 */

/** Raised while parsing when the line contains something the filter will not reason about. */
class Rejection extends Error {}

const SUBSTITUTION = "command substitution and subshells are not allowed";
const EXPANSION = "unquoted expansion ($VAR, {a,b}, *, ?, [..], ~) is not allowed: quote the word";

/**
 * Splits a command line into pipeline segments of words, with quotes and escapes resolved.
 * Redirects are validated and dropped; throws Rejection for anything that is not plain.
 */
function parseSegments(command: string): string[][] {
	if (/[\n\r]/.test(command)) throw new Rejection("newlines and heredocs are not allowed");
	const segments: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quoted = false;
	let redirect: "out" | "dup" | "in" | undefined;
	let i = 0;

	const endWord = () => {
		if (!inWord) return;
		if (redirect) checkRedirectTarget(redirect, word);
		else words.push(word);
		redirect = undefined;
		word = "";
		inWord = false;
		quoted = false;
	};
	/** Closes the current segment. An operator needs a command before it, and a pipe or && or || one after it too. */
	let needsCommand = false;
	const endSegment = (operator?: string) => {
		endWord();
		if (redirect) throw new Rejection("a redirect has no target");
		if (words.length) segments.push(words);
		else if (operator || needsCommand) throw new Rejection("an operator has no command next to it");
		words = [];
		needsCommand = operator === "|" || operator === "&&" || operator === "||";
	};
	/** A leading number is a file descriptor ("2>"), not an argument. */
	const startRedirect = () => {
		if (inWord && !quoted && /^\d+$/.test(word)) {
			word = "";
			inWord = false;
		} else endWord();
	};

	scan: while (i < command.length) {
		const c = command[i];
		switch (c) {
			case " ":
			case "\t":
				endWord();
				i++;
				break;
			case "'": {
				const end = command.indexOf("'", i + 1);
				if (end < 0) throw new Rejection("unterminated quote");
				word += command.slice(i + 1, end);
				inWord = quoted = true;
				i = end + 1;
				break;
			}
			case '"': {
				i++;
				inWord = quoted = true;
				for (;;) {
					const d = command[i];
					if (d === undefined) throw new Rejection("unterminated quote");
					if (d === '"') {
						i++;
						break;
					}
					if (d === "\\") {
						const e = command[i + 1];
						if (e === undefined) throw new Rejection("unterminated quote");
						word += '$`"\\'.includes(e) ? e : d + e;
						i += 2;
						continue;
					}
					if (d === "`" || (d === "$" && (command[i + 1] === "(" || command[i + 1] === "{"))) throw new Rejection(SUBSTITUTION);
					if (d === "$" && command[i + 1] !== undefined && /[A-Za-z0-9_@*#?$!-]/.test(command[i + 1]!)) throw new Rejection(EXPANSION);
					word += d;
					i++;
				}
				break;
			}
			case "\\": {
				const e = command[i + 1];
				if (e === undefined) throw new Rejection("a trailing backslash is not allowed");
				word += e;
				inWord = quoted = true;
				i += 2;
				break;
			}
			case "`":
			case "(":
			case ")":
				throw new Rejection(SUBSTITUTION);
			case "$": {
				const next = command[i + 1];
				if (next === "(" || next === "{") throw new Rejection(SUBSTITUTION);
				if (next === "'" || next === '"') throw new Rejection("$'...' and $\"...\" quoting is not allowed");
				// $NAME, $1, $@ and the like expand before the command sees them, so a checked word
				// could still turn into "-o file" ($IFS splits words). Only a lone $ is literal.
				if (next !== undefined && /[A-Za-z0-9_@*#?$!-]/.test(next)) throw new Rejection(EXPANSION);
				word += c;
				inWord = true;
				i++;
				break;
			}
			case "#":
				if (inWord) {
					word += c;
					i++;
					break;
				}
				break scan; // a comment runs to the end of the line
			case ";":
				endSegment(";");
				i++;
				break;
			case "|":
				if (command[i + 1] === "|") {
					endSegment("||");
					i += 2;
					break;
				}
				endSegment("|");
				i++;
				if (command[i] === "&") i++; // |&
				break;
			case "&":
				if (command[i + 1] === ">") {
					endWord();
					i++; // &> and &>> redirect like >
					break;
				}
				if (command[i + 1] === "&") {
					endSegment("&&");
					i += 2;
				} else {
					endSegment("&");
					i++;
				}
				break;
			case ">": {
				startRedirect();
				if (redirect) throw new Rejection("a redirect has no target");
				i++;
				let kind: "out" | "dup" = "out";
				if (command[i] === ">" || command[i] === "|") i++;
				else if (command[i] === "&") {
					kind = "dup";
					i++;
				}
				redirect = kind;
				break;
			}
			case "<": {
				const next = command[i + 1];
				if (next === "<") throw new Rejection("heredocs and here-strings are not allowed");
				if (next === ">") throw new Rejection("read-write redirects are not allowed");
				startRedirect();
				if (redirect) throw new Rejection("a redirect has no target");
				i++;
				if (command[i] === "&") {
					redirect = "dup";
					i++;
				} else redirect = "in";
				break;
			}
			case "{":
			case "}":
			case "*":
			case "?":
			case "[":
				// Brace expansion and globbing happen after this check, so "{--output=f,}" or
				// "-[o]" would reach the command as an option this filter never saw. Quote them.
				throw new Rejection(EXPANSION);
			case "~":
				if (!inWord) throw new Rejection(EXPANSION);
				word += c;
				i++;
				break;
			default:
				word += c;
				inWord = true;
				i++;
		}
	}
	endSegment();
	if (!segments.length) throw new Rejection("empty command");
	return segments;
}

/**
 * Output may only go to /dev/null or duplicate another descriptor ("2>&1"). Input may come from
 * any file except bash's /dev/tcp and /dev/udp, which open network connections.
 */
function checkRedirectTarget(kind: "out" | "dup" | "in", target: string): void {
	if (kind === "in") {
		if (/^\/dev\/(tcp|udp)\//.test(target)) throw new Rejection("network redirects are not allowed");
		return;
	}
	if (target === "/dev/null") return;
	if (kind === "dup" && /^(\d+-?|-)$/.test(target)) return;
	throw new Rejection(`redirecting output to ${target} is not allowed (only /dev/null)`);
}

/** The name of a long option ("--output=f" gives "output"), or undefined for anything else. */
function longName(arg: string): string | undefined {
	return arg.startsWith("--") && arg.length > 2 ? arg.slice(2).split("=")[0] : undefined;
}

/** True if arg is a long option that is `full` or an abbreviation of it (GNU getopt and git accept those). */
function abbreviates(arg: string, full: string): boolean {
	const name = longName(arg);
	return name !== undefined && full.startsWith(name);
}

/** True for a short-option cluster such as "-lao" that contains the letter. */
function hasShort(arg: string, letters: string): boolean {
	return new RegExp(`^-[^-]*[${letters}]`).test(arg);
}

type Check = (args: string[]) => string | undefined;

const allowAll: Check = () => undefined;

/** Builds a check that rejects the first argument the predicate flags, naming it. */
function rejectArgs(isDangerous: (arg: string) => boolean, why: string): Check {
	return (args) => {
		const bad = args.find(isDangerous);
		return bad === undefined ? undefined : `${bad} ${why}`;
	};
}

const FIND_UNSAFE = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

const SED_ADDRESS = String.raw`(\d+|\$|/[^/\\]*/)`;
const SED_PRINT = new RegExp(`^(${SED_ADDRESS}(,${SED_ADDRESS})?)?p$`);

const checkSed: Check = (args) => {
	let script: string | undefined;
	for (const a of args) {
		if (a === "-n" || a === "--quiet" || a === "--silent") continue;
		if (a.startsWith("-")) return `sed ${a} is not allowed`;
		script ??= a;
	}
	// A sed script can write files (w) and run commands (e), so only printing an address range is allowed.
	if (script === undefined || !SED_PRINT.test(script)) return "sed is only allowed for printing lines (sed -n 5,10p file)";
};

/** `uniq in out` writes to its second file. The values of -f, -s and -w are not files. */
const checkUniq: Check = (args) => {
	const files = args.filter((a, i) => !a.startsWith("-") && !["-f", "-s", "-w"].includes(args[i - 1]));
	return files.length > 1 ? "uniq with an output file is not allowed" : undefined;
};

const checkEnv: Check = (args) => (args.every((a) => a === "-0" || a === "--null") ? undefined : "env is only allowed without a command");

const GIT_READ = new Set([
	"status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe", "rev-list", "shortlog", "ls-tree", "cat-file",
	"grep", "merge-base", "name-rev", "for-each-ref", "show-ref",
]);
const GIT_LEADING_FLAGS = new Set(["--no-pager", "--no-optional-locks"]);

interface ListingForms {
	flags: string[];
	valued: string[];
	/** Flags that put the command in list mode, where positional words are patterns and not new names. */
	listing: string[];
}
const BRANCH_FORMS: ListingForms = {
	flags: ["-a", "--all", "-r", "--remotes", "-v", "--verbose", "-i", "--ignore-case", "--show-current", "--no-abbrev", "--no-color", "--no-column"],
	valued: ["--sort=", "--format=", "--abbrev=", "--color=", "--column="],
	listing: ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"],
};
const TAG_FORMS: ListingForms = {
	flags: ["-i", "--ignore-case", "--no-color", "--no-column"],
	valued: ["--sort=", "--format=", "--color=", "--column="],
	listing: ["-l", "--list", "-n", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"],
};

/** git branch and git tag create, move and delete refs unless they are only listing. */
function listingOnly(name: string, args: string[], forms: ListingForms): string | undefined {
	let listing = false;
	let positional = false;
	for (const a of args) {
		if (!a.startsWith("-")) {
			positional = true;
			continue;
		}
		const flag = a.replace(/^-n\d+$/, "-n").replace(/^-[arv]{2,}$/, "-v");
		if (forms.listing.includes(flag)) listing = true;
		else if (!forms.flags.includes(flag) && !forms.valued.some((v) => flag.startsWith(v))) return `git ${name} ${a} is not allowed (listing only)`;
	}
	return positional && !listing ? `git ${name} with a name would create or change a ref (listing only: use --list)` : undefined;
}

const checkGit: Check = (args) => {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		if (GIT_LEADING_FLAGS.has(args[i])) i++;
		else if (args[i] === "-C") i += 2;
		else return `git ${args[i]} before the subcommand is not allowed`;
	}
	const sub = args[i];
	if (sub === undefined) return "git needs a read-only subcommand";
	const rest = args.slice(i + 1);
	if (GIT_READ.has(sub)) {
		const bad = rest.find(
			(a) =>
				abbreviates(a, "output") ||
				abbreviates(a, "ext-diff") ||
				abbreviates(a, "textconv") ||
				abbreviates(a, "no-index") ||
				abbreviates(a, "open-files-in-pager") ||
				(sub === "grep" && hasShort(a, "O")),
		);
		return bad === undefined ? undefined : `git ${sub} ${bad} can write files or run programs`;
	}
	switch (sub) {
		case "branch":
			return listingOnly("branch", rest, BRANCH_FORMS);
		case "tag":
			return listingOnly("tag", rest, TAG_FORMS);
		case "remote":
			if (rest.every((a) => a === "-v" || a === "--verbose")) return undefined;
			// "remote show" contacts the remote, so only the offline forms are allowed.
			if (rest[0] === "get-url" && rest.slice(1).every((a) => !a.startsWith("-") || a === "--push" || a === "--all")) return undefined;
			return "git remote is only allowed for listing (git remote -v, git remote get-url)";
		case "config": {
			const readers = ["--get", "--get-all", "--get-regexp", "--list", "-l"];
			const scopes = ["--local", "--global", "--system", "--worktree", "--show-origin", "--show-scope", "--name-only", "-z", "--null", "--includes", "--no-includes"];
			const flags = rest.filter((a) => a.startsWith("-"));
			if (!flags.some((a) => readers.includes(a))) return "git config is only allowed with --get or --list";
			const bad = flags.find((a) => !readers.includes(a) && !scopes.includes(a));
			return bad === undefined ? undefined : `git config ${bad} is not allowed`;
		}
		default:
			return `git ${sub} is not on the read-only list`;
	}
};

const SCRIPT_SHELL_FLAGS = ["script-shell", "shell-emulator"];

/** npm, pnpm and yarn: inspection commands, plus the lint, typecheck and test scripts. */
const checkPackageManager: Check = (args) => {
	const sub = args[0];
	if (["list", "ls", "view", "info", "why", "outdated"].includes(sub)) return undefined;
	if (sub === "test" || (sub === "run" && ["lint", "typecheck", "test"].includes(args[1]))) {
		const bad = args.slice(1).find((a) => SCRIPT_SHELL_FLAGS.some((f) => abbreviates(a, f)));
		return bad === undefined ? undefined : `${bad} could run another program`;
	}
	return "only list, view, info, why, outdated, test and run lint, typecheck or test are allowed";
};

const checkCargo: Check = (args) => {
	if (args[0] !== "check" && args[0] !== "test") return "only cargo check and cargo test are allowed";
	const bad = args.find((a) => a === "--config" || a.startsWith("--config=") || /^-Z/.test(a));
	return bad === undefined ? undefined : `cargo ${bad} can run other programs`;
};

const GO_UNSAFE_FLAG = /^-{1,2}(exec|toolexec|vettool|c|o|outputdir|trace|fuzz|[a-z.]*profile)(=|$)/;
const checkGo: Check = (args) => {
	if (args[0] !== "vet" && args[0] !== "test") return "only go vet and go test are allowed";
	const bad = args.find((a) => GO_UNSAFE_FLAG.test(a));
	return bad === undefined ? undefined : `go ${bad} can write files or run other programs`;
};

const versionOnly = (...flags: string[]): Check => (args) => (args.length === 1 && flags.includes(args[0]) ? undefined : "only the version flag is allowed");

/**
 * The commands that may start a pipeline segment. Left out on purpose: awk (system(), getline and
 * print > file), yq (in-place edit and split output), less and more (shell escapes), xargs, and anything else that
 * takes a script or a command to run.
 */
const COMMANDS = new Map<string, Check>();
for (const name of ["cd", "cat", "head", "tail", "ls", "pwd", "echo", "printf", "wc", "grep", "diff", "stat", "du", "df", "which", "whereis", "type", "uname", "whoami", "id", "uptime", "ps", "free", "jq", "cut", "tr", "basename", "dirname", "realpath", "readlink", "printenv"]) {
	COMMANDS.set(name, allowAll);
}
COMMANDS.set("find", rejectArgs((a) => FIND_UNSAFE.has(a), "can delete files or run commands"));
COMMANDS.set("fd", rejectArgs((a) => hasShort(a, "xX") || a.startsWith("--exec"), "can run commands"));
COMMANDS.set("rg", rejectArgs((a) => a === "--pre" || a.startsWith("--pre=") || a === "--hostname-bin" || a.startsWith("--hostname-bin="), "runs another program"));
COMMANDS.set("sort", rejectArgs((a) => hasShort(a, "o") || abbreviates(a, "output") || abbreviates(a, "compress-program"), "can write files or run programs"));
COMMANDS.set("uniq", checkUniq);
COMMANDS.set("file", rejectArgs((a) => hasShort(a, "C") || abbreviates(a, "compile"), "writes a file"));
COMMANDS.set("date", rejectArgs((a) => hasShort(a, "s") || abbreviates(a, "set"), "sets the clock"));
COMMANDS.set("tree", rejectArgs((a) => hasShort(a, "o") || a.startsWith("--o"), "writes a file"));
COMMANDS.set("env", checkEnv);
COMMANDS.set("sed", checkSed);
COMMANDS.set("git", checkGit);
for (const name of ["npm", "pnpm", "yarn"]) COMMANDS.set(name, checkPackageManager);
COMMANDS.set("node", versionOnly("--version", "-v"));
COMMANDS.set("python", versionOnly("--version", "-V"));
COMMANDS.set("python3", versionOnly("--version", "-V"));
COMMANDS.set("uv", versionOnly("--version", "-V"));
COMMANDS.set("cargo", checkCargo);
COMMANDS.set("go", checkGo);

/**
 * Why a command line is not allowed in Plan mode, or undefined if every part of it looks read-only.
 */
export function explainBlockedCommand(command: string): string | undefined {
	let segments: string[][];
	try {
		segments = parseSegments(command);
	} catch (e) {
		if (e instanceof Rejection) return e.message;
		throw e;
	}
	for (const [name, ...args] of segments) {
		const check = COMMANDS.get(name);
		if (!check) return `${name} is not on the read-only list`;
		const why = check(args);
		if (why) return why;
	}
	return undefined;
}

/** True if every pipeline/sequence segment of a command looks read-only. */
export function isReadOnlyCommand(command: string): boolean {
	return explainBlockedCommand(command) === undefined;
}
