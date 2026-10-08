/**
 * Which mode each user message was sent in, read from the session.
 *
 * halo writes a `halo-mode` custom entry at every Build/Plan switch, so the mode of a
 * message is the last such entry before it on the branch (build when there is none). The result is
 * one mode per user message box that pi draws, in order, so the Nth box in the chat is the Nth
 * mode. pi draws a box for a user message only when it has text, and for a skill block only when
 * the block carries a message of its own (the skill itself is a different component).
 */

import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { MODE_ENTRY } from "./modes.ts";
import type { AgentMode } from "./state.ts";

/** The text pi shows for a user message: its text blocks joined, as pi's getUserMessageText does. */
function userText(message: { content?: unknown }): string {
	const c = message.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("");
}

/** Whether pi draws a user message box for this message. */
export function drawsUserBox(message: { role?: string; content?: unknown }): boolean {
	if (message.role !== "user") return false;
	const text = userText(message);
	if (!text) return false;
	const skill = parseSkillBlock(text);
	return skill ? Boolean(skill.userMessage) : true;
}

/**
 * The mode of every user message box, in order. `branch` is the whole branch from the root;
 * `contextIds` are the ids of the entries pi draws (after a compaction, older ones are left out,
 * but their mode entries still count).
 */
export function userMessageModes(branch: readonly any[], contextIds: ReadonlySet<string>): AgentMode[] {
	const modes: AgentMode[] = [];
	let mode: AgentMode = "build";
	for (const e of branch) {
		if (e?.type === "custom" && e.customType === MODE_ENTRY) {
			if (e.data?.mode === "plan" || e.data?.mode === "build") mode = e.data.mode;
		} else if (e?.type === "message" && contextIds.has(e.id) && drawsUserBox(e.message ?? {})) {
			modes.push(mode);
		}
	}
	return modes;
}
