/**
 * Opening a pull or merge request through the forge's own CLI: `gh` for GitHub-style hosts, `glab`
 * for GitLab-style hosts. It works with any host the CLI is signed in to (github.com, GitHub
 * Enterprise, gitlab.com, self-hosted GitLab); nothing here knows a host by name beyond a hint to
 * try the likelier CLI first.
 */

import { run } from "./run.ts";

export type ForgeCli = "gh" | "glab";

export interface PrRequest {
	base: string;
	head: string;
	title: string;
	body: string;
	draft: boolean;
}

/** The CLIs to try for a host, likeliest first. */
export function candidateClis(host: string | undefined): ForgeCli[] {
	return host?.includes("gitlab") ? ["glab", "gh"] : ["gh", "glab"];
}

/** Arguments (and stdin) that create the request with the given CLI. */
export function createArgs(cli: ForgeCli, r: PrRequest): { args: string[]; input?: string } {
	if (cli === "gh") {
		const args = ["pr", "create", "--base", r.base, "--head", r.head, "--title", r.title, "--body-file", "-"];
		if (r.draft) args.push("--draft");
		return { args, input: r.body };
	}
	const args = ["mr", "create", "--target-branch", r.base, "--source-branch", r.head, "--title", r.title, "--description", r.body, "--yes"];
	if (r.draft) args.push("--draft");
	return { args };
}

/** The first URL in a command's output, if any. */
export function findUrl(text: string): string | undefined {
	return text.match(/https?:\/\/[^\s<>"')]+/)?.[0];
}

/** The first candidate CLI that is installed and signed in for `host`. */
export async function findForge(cwd: string, host: string | undefined): Promise<ForgeCli | undefined> {
	for (const cli of candidateClis(host)) {
		const args = host ? ["auth", "status", "--hostname", host] : ["auth", "status"];
		if ((await run(cli, args, cwd, { timeoutMs: 15_000 })).code === 0) return cli;
	}
	return undefined;
}

export async function createRequest(cwd: string, cli: ForgeCli, r: PrRequest) {
	const { args, input } = createArgs(cli, r);
	return run(cli, args, cwd, { input, timeoutMs: 120_000, env: { GH_PROMPT_DISABLED: "1", NO_PROMPT: "1" } });
}
