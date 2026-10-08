/**
 * Pure logic for the MCP footer status (no pi imports, so the tests run standalone).
 *
 * pi's built-in MCP support has no public connection-state API, so the state is inferred:
 *   - configured: enabled servers from ~/.pi/agent/mcp.json, the trusted project's
 *     .pi/mcp.json (project entries replace global ones of the same name), plus servers
 *     extensions registered with pi.registerMcpServer() (mcp.json wins on name clashes).
 *   - connected: the server has at least one registered tool in namespace mcp__<server>
 *     whose exposure is not "hidden". Tools register when a server connects; a disabled
 *     server's tools are re-registered as hidden.
 * Limits: a dropped connection keeps its tools registered until the next call reconnects it,
 * and a server that offers zero tools never counts as connected.
 */

/** Only `enabled` is read; other mcp.json fields (url, command, ...) pass through untyped. */
export interface ServerConfig {
	enabled?: boolean;
	url?: string;
	command?: string;
}

export interface ToolLike {
	exposure: string;
	namespace?: { name: string };
}

/** Same rule as pi's mcpNamespace(): "-" and "_" are equivalent in server names. */
export function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}`;
}

/** The mcpServers object of an mcp.json text, or {} when missing or invalid. */
export function parseMcpServers(text: string | undefined): Record<string, ServerConfig> {
	if (!text) return {};
	try {
		const servers = JSON.parse(text)?.mcpServers;
		if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return {};
		const out: Record<string, ServerConfig> = {};
		for (const [name, cfg] of Object.entries(servers)) {
			if (typeof cfg === "object" && cfg !== null && !Array.isArray(cfg)) out[name] = cfg as ServerConfig;
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Names of enabled servers, in precedence order: global < project (replaces by namespace),
 * then registered servers whose namespace no config file defines.
 */
export function enabledServers(
	global: Record<string, ServerConfig>,
	project: Record<string, ServerConfig>,
	registered: Array<{ name: string; config: ServerConfig }>,
): string[] {
	const byNs = new Map<string, { name: string; config: ServerConfig }>();
	for (const [name, config] of Object.entries(global)) byNs.set(mcpNamespace(name), { name, config });
	for (const [name, config] of Object.entries(project)) byNs.set(mcpNamespace(name), { name, config });
	for (const r of registered) {
		const ns = mcpNamespace(r.name);
		if (!byNs.has(ns)) byNs.set(ns, r);
	}
	return [...byNs.values()].filter((s) => s.config.enabled !== false).map((s) => s.name);
}

/** Servers among `servers` that have at least one non-hidden registered tool. */
export function connectedServers(servers: string[], tools: ToolLike[]): string[] {
	const live = new Set(tools.filter((t) => t.exposure !== "hidden" && t.namespace).map((t) => t.namespace!.name));
	return servers.filter((s) => live.has(mcpNamespace(s)));
}

export type StatusLevel = "ok" | "partial" | "down";

export interface McpStatus {
	connected: number;
	enabled: number;
	level: StatusLevel;
	/** Enabled servers that are not connected yet. */
	pending: string[];
}

/** Undefined when no server is enabled (the footer segment is hidden). */
export function summarize(enabled: string[], connected: string[]): McpStatus | undefined {
	if (enabled.length === 0) return undefined;
	const live = new Set(connected);
	const pending = enabled.filter((s) => !live.has(s));
	const level: StatusLevel = pending.length === 0 ? "ok" : connected.length === 0 ? "down" : "partial";
	return { connected: connected.length, enabled: enabled.length, level, pending };
}

export function formatStatus(s: McpStatus): string {
	return `${s.connected}/${s.enabled}`;
}
