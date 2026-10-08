/**
 * halo: an OpenCode-style TUI for pi, with a brand that another package can replace (brand.ts).
 *
 * Pieces (each in its own file):
 *   layout.ts    right sidebar (fullscreen split, overlay fallback)       ctrl+x b
 *   home.ts      OpenCode-style home screen (logo, centred prompt, tip, bottom bar)
 *   sidebar.ts   session title, context/cost, status widgets, files, todo
 *   footer.ts    one-line status bar under the prompt
 *   editor.ts    left-rail prompt with mode badge + model, leader key, Tab mode switch
 *   commands.ts  ctrl+x leader actions and the ctrl+p command palette
 *   modes.ts     Build / Plan (read-only) agent modes
 *   tools.ts     one-line tool rows ("→ Read x.ts  120 lines")
 *   messages.ts  user prompts with a coloured left bar
 *   peek.ts      thinking peek in the hidden-thinking label
 *   telemetry.ts per-run TPS/TTFT/tokens/cost summary
 *   api.ts       the widget registry other extensions use (registerWidget)
 *
 * Commands: /halo [on|off|sidebar|status]
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
	type Theme,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { iconSet, iconSource, saveIconSetting, setIconSetting } from "./icons.ts";
import { alert as ringAlert, type AlertReason, describeAlert, loadAlert, parseAlertArg, plainTitle, runOutcome, saveAlert, shouldAlert } from "./alert.ts";
import { formatWidgetList, getRegistry, installHost, invalidateWidgets, refreshWidget, setWidgetDisabled, widgetActions, widgetActionValue, widgetInfo } from "./api.ts";
import {
	CommandPalette,
	leaderActions,
	leaderHelpLines,
	paletteItems,
	runPaletteValue,
	type LeaderAction,
} from "./commands.ts";
import { PromptEditor } from "./editor.ts";
import { installFooter } from "./footer.ts";
import { renderHeader } from "./header.ts";
import { PLACEHOLDERS, TIPS } from "./home.ts";
import { installLayout, type LayoutHandle, piRootOf } from "./layout.ts";
import { installMessageStyle, setChatContainer } from "./messages.ts";
import { installModes } from "./modes.ts";
import { fit, sanitize, spinnerFrame } from "./palette.ts";
import { ThinkingPeek } from "./peek.ts";
import { readGit } from "./session-info.ts";
import type { ModelParts } from "./prompt-row.ts";
import { SIDEBAR_WIDTH } from "./sidebar.ts";
import { createState } from "./state.ts";
import { formatTelemetry, TelemetryTracker } from "./telemetry.ts";
import { installToolRenderers } from "./tools.ts";

// pi's built-in slash commands: pi.getCommands() only lists extension, prompt and skill commands.
const BUILTIN_COMMANDS: { name: string; description: string }[] = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model" },
	{ name: "tree", description: "Navigate session tree" },
	{ name: "thinking", description: "Set thinking level" },
	{ name: "scoped-models", description: "Enable/disable models for cycling" },
	{ name: "export", description: "Export session" },
	{ name: "import", description: "Import a session from JSONL" },
	{ name: "share", description: "Share session as a secret gist" },
	{ name: "copy", description: "Copy last agent message" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session" },
	{ name: "trust", description: "Save project trust decision" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload extensions, themes, keybindings" },
	{ name: "quit", description: "Quit pi" },
];

const LEADER_TIMEOUT_MS = 2000;
const SIDEBAR_MIN_TERMINAL_WIDTH = 116; // keeps the transcript as wide as it was at the old 42-column sidebar and 110 columns
const GIT_POLL_MS = 4000;

export default function (pi: ExtensionAPI) {
	const state = createState();
	const registry = getRegistry();
	installHost();
	const telemetry = new TelemetryTracker();

	let enabled = true;
	let alertSettings = loadAlert();
	/** Set while the window title carries an alert mark, so the next prompt clears it. */
	let titleMarked = false;
	/** How the last run ended, from agent_end, for the alert at agent_settled. */
	let lastOutcome: "finished" | "failed" | "aborted" = "finished";
	let active = false;
	let theme: Theme | undefined;
	let tui: TUI | undefined;
	let editor: PromptEditor | undefined;
	let layout: LayoutHandle | undefined;
	let cleanupFooter: (() => void) | undefined;
	let cleanupMessages: (() => void) | undefined;
	let requestFooter: (() => void) | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;

	const peek = new ThinkingPeek(
		() => tui,
		() => Math.max(10, (tui?.terminal.columns ?? 100) - (layout?.isShown() ? SIDEBAR_WIDTH : 0) - 4),
	);

	const render = () => {
		requestFooter?.();
		tui?.requestRender();
	};

	/** pi's chat container: the Container whose children include message/tool components. */
	const findChatContainer = (): { children: unknown[] } | undefined => {
		const stack: any[] = [piRootOf(tui)];
		const seen = new Set<object>();
		while (stack.length) {
			const v = stack.pop();
			if (!v || typeof v !== "object" || seen.has(v)) continue;
			seen.add(v);
			const kids = v.children;
			if (Array.isArray(kids)) {
				if (kids.some((k: any) => /^(UserMessage|AssistantMessage|ToolExecution)Component$/.test(k?.constructor?.name ?? ""))) return v;
				for (const k of kids) stack.push(k);
			}
			if (v.child) stack.push(v.child);
		}
		return undefined;
	};
	let foundChat: unknown;
	const refreshChatContainer = () => {
		const c = findChatContainer();
		if (!c) return;
		setChatContainer(c);
		// Messages drawn before the chat was found (a resumed session) guessed their mode colour;
		// draw them again now that they can be matched to the session.
		if (c !== foundChat) {
			foundChat = c;
			tui?.requestRender();
		}
	};
	registry.requestRender = render;

	installToolRenderers(pi);

	const modes = installModes(pi, state, render);

	const submit = (text: string) => {
		// pi's command dispatcher is the editor's onSubmit (wired by pi when it installs our editor).
		const fn = (editor as unknown as { onSubmit?: (t: string) => void })?.onSubmit;
		if (fn) fn(text);
		else state.ctx?.ui.setEditorText(text);
	};

	const showLeaderHelp = () => {
		const ctx = state.ctx;
		if (!ctx || !theme) return;
		void ctx.ui.custom<void>(
			(_t, th, _kb, done) => {
				const lines = leaderHelpLines(actions, th);
				return {
					invalidate() {},
					handleInput: () => done(),
					render: (w: number) => {
						const inner = w - 4;
						const b = (s: string) => th.fg("borderMuted", s);
						return [b(`╭${"─".repeat(w - 2)}╮`), ...lines.map((l) => `${b("│")} ${fit(l, inner)} ${b("│")}`), b(`╰${"─".repeat(w - 2)}╯`)];
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: 56 } },
		);
	};

	const actions: LeaderAction[] = leaderActions({
		toggleSidebar: () => {
			layout?.toggle();
			render();
		},
		cycleMode: () => {
			if (state.ctx) modes.cycle(state.ctx);
		},
		showHelp: showLeaderHelp,
	});

	const runLeader = (data: string): boolean => {
		const key = data.length === 1 ? data.toLowerCase() : undefined;
		const action = actions.find((a) => a.key === key);
		if (!action) return false;
		if (typeof action.run === "function") action.run();
		else submit(action.run);
		return true;
	};

	const openPalette = async (ctx: ExtensionContext) => {
		const widgetItems = widgetActions().map((a) => ({
			value: widgetActionValue(a.widgetId, a.id),
			label: `${a.widgetTitle}: ${a.label}`,
			description: a.description,
			hint: "widget",
		}));
		const items = paletteItems(pi, BUILTIN_COMMANDS, actions, widgetItems);
		const value = await ctx.ui.custom<string | undefined>(
			(_t, th, _kb, done) => new CommandPalette(items, th, done),
			{ overlay: true, overlayOptions: { anchor: "top-center", width: "60%", minWidth: 50, offsetY: 3, maxHeight: "70%" } },
		);
		if (value) runPaletteValue(value, ctx, actions, submit);
	};

	const modelParts = (): ModelParts => {
		const m = state.ctx?.model;
		if (!m) return { model: "no model" };
		const provider = m.provider ? m.provider[0]!.toUpperCase() + m.provider.slice(1) : undefined;
		return { model: m.name ?? m.id, provider, effort: m.reasoning ? pi.getThinkingLevel() : undefined };
	};
	/** One line for the startup header: "Claude Opus 5.5 · Anthropic · medium". */
	const modelLabel = (): string => {
		const p = modelParts();
		return [p.model, p.provider, p.effort].filter(Boolean).join(" · ");
	};

	/** True once the current branch has a user or assistant message. */
	const sessionStarted = (): boolean => {
		const c = state.ctx;
		if (!c) return false;
		try {
			return (c.sessionManager.getBranch() as any[]).some(
				(e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"),
			);
		} catch {
			return false;
		}
	};

	/** Most recent other session with messages in this directory (home screen resume hint). */
	const refreshLastSession = async (ctx: ExtensionContext) => {
		try {
			const current = ctx.sessionManager.getSessionId();
			const list = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
			const last = list
				.filter((s) => s.id !== current && s.messageCount > 0)
				.sort((a, b) => b.modified.getTime() - a.modified.getTime())[0];
			if (state.ctx !== ctx) return;
			const label = sanitize(last?.name || last?.firstMessage || "");
			state.lastSession = last ? { path: last.path, label: label || "untitled", modified: last.modified } : undefined;
			render();
		} catch {
			// listing is best-effort
		}
	};

	const refreshGit = async (ctx: ExtensionContext) => {
		const info = await readGit(ctx.cwd);
		if (state.ctx !== ctx) return;
		// Repaint only on a change: this also runs on a timer.
		if (JSON.stringify(info) === JSON.stringify(state.git)) return;
		state.git = info;
		render();
	};

	/**
	 * Git changes outside pi (a commit or checkout in another terminal, edits by other tools) fire
	 * no event, so poll. readGit skips optional locks, so this never blocks the user's own git.
	 */
	let gitTimer: ReturnType<typeof setInterval> | undefined;
	let gitBusy = false;
	const startGitPoll = (ctx: ExtensionContext) => {
		stopGitPoll();
		gitTimer = setInterval(() => {
			if (gitBusy || state.ctx !== ctx) return;
			gitBusy = true;
			void refreshGit(ctx).finally(() => (gitBusy = false));
		}, GIT_POLL_MS);
		gitTimer.unref?.();
	};
	const stopGitPoll = () => {
		if (gitTimer) clearInterval(gitTimer);
		gitTimer = undefined;
	};

	const install = (ctx: ExtensionContext) => {
		if (active || !enabled || ctx.mode !== "tui") return;
		active = true;
		const placeholder = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];

		ctx.ui.setHeader((t, th) => {
			tui = t;
			theme = th;
			// OpenCode shows its logo on the home screen only; once the session has a message the
			// header collapses so the transcript starts at the top.
			return {
				invalidate() {},
				render: (w: number) =>
					sessionStarted() || state.home() ? [] : renderHeader(th, w, { model: modelLabel(), cwd: state.ctx?.cwd ?? ctx.cwd, version: VERSION }),
			};
		});

		cleanupFooter = installFooter(ctx, state, (fn) => {
			requestFooter = fn;
		});

		ctx.ui.setEditorComponent((t, editorTheme, keybindings) => {
			tui = t;
			editor = new PromptEditor(t, editorTheme, keybindings, {
				state,
				theme: () => theme ?? ctx.ui.theme,
				modelParts,
				placeholder: () => (state.home() ? `Ask anything… "${placeholder}"` : undefined),
				blink: () => state.home(),
				onModeCycle: () => {
					if (state.ctx) modes.cycle(state.ctx);
				},
				onLeaderKey: runLeader,
				onLeaderState: () => tui?.requestRender(),
				onPalette: () => {
					if (state.ctx) void openPalette(state.ctx);
				},
				onStatusChange: () => requestFooter?.(),
				leaderTimeoutMs: LEADER_TIMEOUT_MS,
			});
			return editor;
		});

		theme = ctx.ui.theme;
		cleanupMessages = installMessageStyle(state, () => theme ?? state.ctx?.ui.theme);
		layout = installLayout(ctx, state, {
			width: SIDEBAR_WIDTH,
			minTerminalWidth: SIDEBAR_MIN_TERMINAL_WIDTH,
			piVersion: VERSION,
			home: () => !sessionStarted(),
			tipIndex: Math.floor(Math.random() * TIPS.length),
		});
		state.sidebarShown = () => layout?.isShown() ?? false;
		state.home = () => state.layout === "split" && !sessionStarted();
		ctx.ui.setWorkingIndicator({ frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"].map((f) => spinnerFrame(ctx.ui.theme, f)), intervalMs: 80 });
	};

	const uninstall = (ctx: ExtensionContext | undefined) => {
		if (!active) return;
		active = false;
		layout?.dispose();
		layout = undefined;
		state.sidebarShown = () => false;
		state.home = () => false;
		cleanupFooter?.();
		cleanupFooter = undefined;
		cleanupMessages?.();
		cleanupMessages = undefined;
		setChatContainer(undefined);
		requestFooter = undefined;
		if (ctx) {
			try {
				ctx.ui.setHeader(undefined);
				ctx.ui.setEditorComponent(undefined);
				ctx.ui.setWorkingIndicator();
				ctx.ui.setHiddenThinkingLabel();
			} catch {
				// stale ctx
			}
		}
		editor?.dispose();
		editor = undefined;
	};

	const stopWorkingTimer = () => {
		if (workingTimer) clearInterval(workingTimer);
		workingTimer = undefined;
	};

	pi.registerShortcut("ctrl+alt+b", {
		description: "halo: toggle sidebar",
		handler: () => {
			layout?.toggle();
			render();
		},
	});

	pi.on("session_start", async (_e, ctx) => {
		state.ctx = ctx;
		registry.ctx = ctx;
		state.workingSince = undefined;
		state.lastDurationMs = undefined;
		if (ctx.mode !== "tui") return;
		install(ctx);
		modes.restore(ctx);
		void refreshGit(ctx);
		startGitPoll(ctx);
		state.lastSession = undefined;
		if (!sessionStarted()) void refreshLastSession(ctx);
		// Resumed sessions render their history after session_start.
		setTimeout(refreshChatContainer, 500);
		render();
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		stopWorkingTimer();
		stopGitPoll();
		uninstall(ctx);
		state.ctx = undefined;
		registry.ctx = undefined;
		registry.requestRender = () => {};
	});

	// The title goes out as an OSC sequence, and the folder name is chosen by whoever made the folder.
	const sessionTitle = (ctx: ExtensionContext) => sanitize(plainTitle(ctx.cwd, safeName(ctx)));
	const safeName = (ctx: ExtensionContext): string | undefined => {
		try {
			return sanitize(ctx.sessionManager.getSessionName()) || undefined;
		} catch {
			return undefined; // stale ctx after a session switch
		}
	};
	/** Ring the bell and mark the title, for a run that has lasted long enough. */
	const notifyUser = (ctx: ExtensionContext, reason: AlertReason, durationMs: number | undefined) => {
		if (!active || ctx.mode !== "tui" || !shouldAlert(alertSettings, durationMs)) return;
		try {
			ringAlert({ write: (d) => process.stdout.write(d), setTitle: (t) => ctx.ui.setTitle(t) }, reason, sessionTitle(ctx));
			titleMarked = true;
		} catch {
			// a closed terminal or stale ctx: nothing to alert
		}
	};
	const clearTitleMark = (ctx: ExtensionContext) => {
		if (!titleMarked) return;
		titleMarked = false;
		try {
			ctx.ui.setTitle(sessionTitle(ctx));
		} catch {
			// stale ctx
		}
	};
	// A prompt that opens while the agent is running (a tool asking you to confirm, say) is the agent
	// waiting for you. One you opened yourself while idle is not, so it has no duration.
	pi.on("ui_prompt_start", async (_e, ctx) => notifyUser(ctx, "waiting", state.workingSince ? Date.now() - state.workingSince : undefined));
	pi.on("ui_prompt_end", async (_e, ctx) => clearTitleMark(ctx));

	pi.on("agent_start", async (e, ctx) => {
		clearTitleMark(ctx);
		telemetry.handle(e);
		state.workingSince = Date.now();
		state.lastDurationMs = undefined;
		stopWorkingTimer();
		workingTimer = setInterval(() => requestFooter?.(), 1000);
		workingTimer.unref?.();
	});
	pi.on("turn_start", async (e) => {
		telemetry.handle(e);
	});
	pi.on("message_start", async (e) => {
		telemetry.handle(e);
		if (e.message?.role === "assistant" || e.message?.role === "user") peek.reset();
		if (e.message?.role === "user") setTimeout(refreshChatContainer, 0);
	});
	pi.on("message_update", async (e, ctx) => {
		telemetry.handle(e);
		if (!active || ctx.isIdle() || e.message?.role !== "assistant") return;
		peek.update(e.message);
	});
	pi.on("message_end", async (e) => {
		telemetry.handle(e);
		if (e.message?.role === "assistant") peek.end();
		render();
	});
	pi.on("turn_end", async (e) => {
		telemetry.handle(e);
	});
	pi.on("tool_execution_start", async () => refreshChatContainer());
	pi.on("tool_execution_end", async () => render());
	pi.on("agent_end", async (e, ctx) => {
		lastOutcome = runOutcome(e.messages);
		stopWorkingTimer();
		if (state.workingSince) state.lastDurationMs = Date.now() - state.workingSince;
		state.workingSince = undefined;
		void refreshGit(ctx);
		state.lastSession = undefined;
		if (!sessionStarted()) void refreshLastSession(ctx);
		render();
	});
	pi.on("agent_settled", async (e, ctx) => {
		const t = telemetry.handle(e);
		if (t && active && ctx.mode === "tui") ctx.ui.notify(formatTelemetry(t, ctx.ui.theme), "info");
		peek.reset();
		// After retries and compaction: the run is over for good. A user abort never rings.
		if (lastOutcome !== "aborted") notifyUser(ctx, lastOutcome, state.lastDurationMs);
	});
	pi.on("model_select", async () => render());
	pi.on("thinking_level_select", async () => render());
	pi.on("session_tree", async (_e, ctx) => {
		modes.restore(ctx);
		render();
	});
	pi.on("session_compact", async () => render());
	pi.on("session_info_changed", async () => render());

	pi.registerCommand("halo-resume-last", {
		description: "halo: resume the most recent other session in this directory",
		handler: async (_args, ctx) => {
			if (!state.lastSession) await refreshLastSession(ctx);
			const last = state.lastSession;
			if (!last) {
				ctx.ui.notify("No earlier session in this directory.", "info");
				return;
			}
			await ctx.switchSession(last.path);
		},
	});

	pi.registerCommand("widgets", {
		description: "halo widgets: /widgets [list|disable ID|enable ID|refresh ID]",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const opts = ["list", "disable", "enable", "refresh"].filter((o) => o.startsWith(parts[0] ?? ""));
				return opts.length ? opts.map((o) => ({ value: o, label: o })) : null;
			}
			const ids = widgetInfo().map((w) => w.id).filter((id) => id.startsWith(parts[1] ?? ""));
			return ids.length ? ids.map((id) => ({ value: `${parts[0]} ${id}`, label: id })) : null;
		},
		handler: async (args, ctx) => {
			const [sub = "list", id] = args.trim().split(/\s+/);
			if (sub === "disable" || sub === "enable" || sub === "refresh") {
				const ok = !id ? false : sub === "refresh" ? refreshWidget(id) : setWidgetDisabled(id, sub === "disable");
				ctx.ui.notify(ok ? `widget ${id}: ${sub}d`.replace("refreshd", "refreshing") : `No widget ${id ? `"${id}"` : "id given"}. Try /widgets list.`, ok ? "info" : "warning");
				return;
			}
			ctx.ui.notify(formatWidgetList(widgetInfo()), "info");
		},
	});

	pi.registerCommand("halo", {
		description: "halo: /halo [on|off|sidebar|status|alert [off|on|SECONDS]|icons [nerd|plain|auto]]",
		getArgumentCompletions: (prefix) => {
			const opts = ["on", "off", "sidebar", "status", "alert", "icons"].filter((o) => o.startsWith(prefix.trim()));
			return opts.length ? opts.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "icons" || sub.startsWith("icons ")) {
				const arg = sub.slice("icons".length).trim();
				if (arg) {
					if (arg !== "nerd" && arg !== "plain" && arg !== "auto") {
						ctx.ui.notify("Usage: /halo icons [nerd|plain|auto]", "warning");
						return;
					}
					const choice = arg === "auto" ? undefined : arg;
					setIconSetting(choice);
					saveIconSetting(choice);
					invalidateWidgets();
					refreshChatContainer();
					render();
				}
				const src = iconSource();
				const why = src === "env" ? " (set by PI_HALO_ICONS, which wins over the saved setting)" : src === "setting" ? "" : src === "brand" ? " (the brand's default)" : " (the default)";
				ctx.ui.notify(`icons: ${iconSet()}${why}. Nerd needs a Nerd Font in the terminal. /halo icons nerd|plain|auto`, "info");
				return;
			}
			if (sub === "alert" || sub.startsWith("alert ")) {
				const arg = sub.slice("alert".length).trim();
				if (arg) {
					const change = parseAlertArg(arg);
					if (!change) {
						ctx.ui.notify("Usage: /halo alert [off|on|SECONDS]  (for example 45, 90s or 2m)", "warning");
						return;
					}
					alertSettings = { ...alertSettings, ...change };
					saveAlert(alertSettings);
				}
				ctx.ui.notify(describeAlert(alertSettings), "info");
				return;
			}
			if (sub === "off") {
				enabled = false;
				uninstall(ctx);
				ctx.ui.notify("halo off for this session. /halo on to restore.", "info");
				return;
			}
			if (sub === "on") {
				enabled = true;
				install(ctx);
				render();
				return;
			}
			if (sub === "sidebar") {
				layout?.toggle();
				render();
				return;
			}
			const widgets = [...registry.widgets.keys()].join(", ") || "none";
			ctx.ui.notify(
				`halo ${active ? "on" : "off"} · layout ${state.layout} · sidebar ${layout?.isShown() ? "shown" : "hidden"} · mode ${state.mode}\nwidgets: ${widgets}`,
				"info",
			);
		},
	});
}
