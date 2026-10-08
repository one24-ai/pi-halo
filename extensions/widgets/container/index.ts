/**
 * Container widget: shows when pi itself runs inside a container, devcontainer, Codespace or
 * Kubernetes pod (first footer segment, sidebar "Host" row). On the workstation it shows nothing.
 *
 * Detection is pi's own process only: a container reached through `docker exec` from a pi running
 * on the host is not detected, because pi is still on the host.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWidget } from "../../halo/api.ts";
import { type IconLike, ICONS } from "../../halo/icons.ts";
import { containerLabel, detectContainer } from "./detect.ts";

// Nerd Font glyphs: md-docker, md-kubernetes.
const ICON_CONTAINER: IconLike = { nerd: ICONS.widgetContainer.nerd, plain: ICONS.widgetContainer.plain };
const ICON_K8S: IconLike = { nerd: ICONS.widgetK8s.nerd, plain: ICONS.widgetK8s.plain };

export default function (pi: ExtensionAPI) {
	// Can't change during a process's life, so detect once.
	const info = detectContainer();
	if (!info) return;
	registerWidget(pi, {
		id: "container",
		title: "Host",
		order: 0,
		render: () => ({ icon: info.kind === "kubernetes" ? ICON_K8S : ICON_CONTAINER, text: containerLabel(info), color: "accent" }),
		detail: () => [info.kind],
	});
}
