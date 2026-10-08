/**
 * Container detection (no pi imports, so tests run standalone).
 * Moved from ~/.pi/agent/extensions/container-status.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";

type Env = Record<string, string | undefined>;

export interface ContainerInfo {
	/** docker | podman | devcontainer | codespace | kubernetes | container */
	kind: string;
	/** Best available human name: devcontainer/codespace/pod name, else the hostname. */
	name: string;
	/** name came from an explicit label (DEVCONTAINER_NAME): show it without a kind prefix. */
	named?: boolean;
}

export interface Probe {
	env: Env;
	exists: (path: string) => boolean;
	read: (path: string) => string | undefined;
	hostname: () => string;
}

const realProbe: Probe = {
	env: process.env,
	exists: (p) => existsSync(p),
	read: (p) => {
		try {
			return readFileSync(p, "utf8");
		} catch {
			return undefined;
		}
	},
	hostname: () => hostname(),
};

/** Podman writes `name="..."` into /run/.containerenv (rootful; often empty when rootless). */
function podmanName(text: string | undefined): string | undefined {
	const m = text?.match(/^name="([^"]*)"/m);
	return m?.[1] || undefined;
}

/** Container runtime evidence in cgroup/mount tables (catches runtimes without marker files). */
function cgroupRuntime(p: Probe): string | undefined {
	const text = `${p.read("/proc/1/cgroup") ?? ""}\n${p.read("/proc/self/mountinfo") ?? ""}`;
	if (/kubepods/.test(text)) return "kubernetes";
	if (/\/docker\/containers\/|\/docker[-/][0-9a-f]{12,}/.test(text)) return "docker";
	if (/\/containers\/storage\/|libpod/.test(text)) return "podman";
	if (/containerd|\/lxc\//.test(text)) return "container";
	return undefined;
}

export function detectContainer(p: Probe = realProbe): ContainerInfo | undefined {
	const e = p.env;
	const host = p.hostname().split(".")[0] || "container";

	// Devcontainers / Codespaces first: they are containers too, and have better names.
	if (e.CODESPACES === "true") return { kind: "codespace", name: e.CODESPACE_NAME || host };
	if (e.REMOTE_CONTAINERS === "true" || e.DEVCONTAINER === "true" || e.REMOTE_CONTAINERS_IPC) {
		// An explicit DEVCONTAINER_NAME (set by a devcontainer launcher) is shown as-is, without the kind prefix.
		if (e.DEVCONTAINER_NAME) return { kind: "devcontainer", name: e.DEVCONTAINER_NAME, named: true };
		return { kind: "devcontainer", name: e.DEVCONTAINER_ID || host };
	}
	if (e.KUBERNETES_SERVICE_HOST) return { kind: "kubernetes", name: host };
	if (p.exists("/run/.containerenv") || e.container === "podman") {
		return { kind: "podman", name: podmanName(p.read("/run/.containerenv")) || host };
	}
	if (p.exists("/.dockerenv") || e.container === "docker") return { kind: "docker", name: host };
	if (e.container) return { kind: e.container, name: host };
	const cg = cgroupRuntime(p);
	if (cg) return { kind: cg, name: host };
	return undefined;
}

/** Label for a container: the kind is prefixed unless the name already says it. */
export function containerLabel(c: ContainerInfo): string {
	return c.named || c.name.toLowerCase().includes(c.kind) ? c.name : `${c.kind}:${c.name}`;
}
