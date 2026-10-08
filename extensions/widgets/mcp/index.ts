/**
 * MCP widget: "<plug> MCP 6/6" = connected/enabled servers for pi's built-in MCP support.
 * Green when all are connected, yellow when some are, red when none are; hidden when no server is
 * enabled. See status.ts for how "connected" is inferred and its limits; /mcp is authoritative.
 *
 * There is no event for MCP connection changes, so it polls (an in-memory tool list and two small
 * JSON reads). It deliberately does not handle `mcp_servers_change`: handling that event marks an
 * extension as the one that connects registered servers, taking that job from the built-in support.
 *
 * Tests: node --experimental-strip-types test/mcp-status.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerWidget } from "../../halo/api.ts";
import { type IconLike, ICONS } from "../../halo/icons.ts";
import { connectedServers, enabledServers, formatStatus, type McpStatus, parseMcpServers, summarize } from "./status.ts";

const POLL_MS = 2000;
// Nerd Font "md-power-plug" (U+F06A5).
const ICON: IconLike = { nerd: ICONS.widgetMcp.nerd, plain: ICONS.widgetMcp.plain };

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let status: McpStatus | undefined;

	registerWidget(pi, {
		id: "mcp",
		title: "MCP",
		order: 30,
		refreshMs: POLL_MS,
		update: (ctx) => {
			const global = parseMcpServers(readText(join(getAgentDir(), "mcp.json")));
			const project = ctx.isProjectTrusted() ? parseMcpServers(readText(join(ctx.cwd, ".pi", "mcp.json"))) : {};
			const enabled = enabledServers(global, project, pi.getMcpServers());
			status = summarize(enabled, connectedServers(enabled, pi.getAllTools()));
		},
		render: () => {
			if (!status) return undefined;
			const level = status.level === "ok" ? "ok" : status.level === "partial" ? "warn" : "error";
			return { icon: ICON, label: "MCP", text: formatStatus(status), level };
		},
		detail: () => (status?.pending.length ? status.pending.map((s) => `○ ${s} not connected`) : undefined),
	});
}
