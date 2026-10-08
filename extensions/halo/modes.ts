/**
 * Build / Plan agent modes (OpenCode's Tab agent cycle).
 *
 * Build: the normal tool set.
 * Plan: a guardrail, not a sandbox. edit/write are deactivated, bash is limited to read-only
 * commands (readonly-command.ts), and the model is told it is planning. Tools from other extensions
 * (MCP, custom tools) are not restricted. The mode is kept per session branch in a custom entry, so
 * /resume and /tree restore it.
 *
 * The bash allowlist started from pi's plan-mode example (MIT, pi-coding-agent).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { explainBlockedCommand } from "./readonly-command.ts";
import type { AgentMode, UiState } from "./state.ts";

/** The custom session entry written at each mode switch: { mode: "build" | "plan" }. */
export const MODE_ENTRY = "halo-mode";
const ENTRY = MODE_ENTRY;
const PLAN_CONTEXT = "halo-plan-context";
const WRITE_TOOLS = new Set(["edit", "write"]);
const PLAN_NOTICE = "Plan mode: edit and write are off and bash is limited to read-only commands. This is a guardrail, not a sandbox: tools from other extensions (MCP, custom) are not restricted.";

export interface ModeController {
	set(mode: AgentMode, ctx: ExtensionContext, persist?: boolean): void;
	cycle(ctx: ExtensionContext): void;
	restore(ctx: ExtensionContext): void;
}

export function installModes(pi: ExtensionAPI, state: UiState, onChange: () => void): ModeController {
	/**
	 * The tool set from before Plan mode took edit/write away. It is captured once, when entering
	 * Plan from Build, and kept for as long as Plan is in effect (including across restores from
	 * plan to plan), because reading the active tools again would return the already reduced set.
	 */
	let toolsBeforePlan: string[] | undefined;

	/** Makes the active tool set match the mode. Safe to call again for the mode already in effect. */
	const apply = (mode: AgentMode) => {
		if (mode === "plan") {
			toolsBeforePlan ??= pi.getActiveTools();
			pi.setActiveTools(toolsBeforePlan.filter((t) => !WRITE_TOOLS.has(t)));
		} else if (toolsBeforePlan) {
			// Tools that became active while in Plan (an MCP server that finished connecting, a tool
			// the user switched on) are kept: only edit and write come back from the snapshot.
			const now = pi.getActiveTools().filter((t) => !WRITE_TOOLS.has(t));
			pi.setActiveTools([...new Set([...now, ...toolsBeforePlan.filter((t) => WRITE_TOOLS.has(t))])]);
			toolsBeforePlan = undefined;
		}
	};

	const controller: ModeController = {
		set(mode, ctx, persist = true) {
			if (state.mode === mode) return;
			state.mode = mode;
			apply(mode);
			if (persist) pi.appendEntry(ENTRY, { mode });
			if (ctx.hasUI) ctx.ui.notify(mode === "plan" ? PLAN_NOTICE : "Build mode: full tool access", "info");
			onChange();
		},
		cycle(ctx) {
			controller.set(state.mode === "build" ? "plan" : "build", ctx);
		},
		restore(ctx) {
			let mode: AgentMode = "build";
			for (const e of ctx.sessionManager.getBranch() as any[]) {
				if (e.type === "custom" && e.customType === ENTRY && (e.data?.mode === "plan" || e.data?.mode === "build")) mode = e.data.mode;
			}
			state.mode = mode;
			apply(mode);
			onChange();
		},
	};

	pi.on("tool_call", async (event) => {
		if (state.mode !== "plan") return;
		if (WRITE_TOOLS.has(event.toolName)) {
			return { block: true, reason: "Plan mode is read-only. Ask the user to switch to Build mode (Tab) to make changes." };
		}
		if (event.toolName === "bash") {
			const cmd = String((event.input as { command?: unknown }).command ?? "");
			const why = explainBlockedCommand(cmd);
			if (why) return { block: true, reason: `Plan mode allows read-only commands only (${why}). Blocked: ${cmd}` };
		}
	});

	pi.on("before_agent_start", async () => {
		if (state.mode !== "plan") return;
		return {
			message: {
				customType: PLAN_CONTEXT,
				content:
					"[PLAN MODE] You are in read-only plan mode. Investigate with read-only tools, then reply with a concise numbered plan. " +
					"Do not edit or write files and do not run commands that change state; the user will switch to Build mode to execute.",
				display: false,
			},
		};
	});

	// Drop stale plan-mode reminders once back in build mode.
	pi.on("context", async (event) => {
		if (state.mode === "plan") return;
		const messages = event.messages.filter((m: any) => m.customType !== PLAN_CONTEXT);
		return messages.length === event.messages.length ? undefined : { messages };
	});

	return controller;
}
