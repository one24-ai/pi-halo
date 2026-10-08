/**
 * AWS widget: the AWS account (and role, region) pi's environment points at.
 *
 * Resolved locally from env vars and ~/.aws/config. It never calls STS or runs a
 * credential_process, which could open an SSO window just to draw the status line. Resolution
 * order mirrors the AWS SDK:
 *   1. AWS_ACCESS_KEY_ID in env  -> account ID decoded offline from the key ID
 *   2. AWS_PROFILE / AWS_DEFAULT_PROFILE, else [default] if it has a credential source
 *      - role_arn / sso_account_id+sso_role_name -> account ID + role
 *      - credential_process -> whatever a registered resolver says (resolve.ts), else the profile name
 * Region: AWS_REGION > AWS_DEFAULT_REGION > the profile's region (> a resolver's region).
 * The role on the detail line is coloured by its name (roleTone in resolve.ts): read-only roles
 * green, admin-style roles bold in the warning colour.
 *
 * The sidebar counts down to the credentials' expiry ("expires in 42m"), warning inside ten minutes
 * and marking "expired" after. The time comes from SESSION_EXPIRY_VAR, which a credential switcher
 * sets (see resolve.ts), else AWS_CREDENTIAL_EXPIRATION when env keys are set. Without either there
 * is no countdown: a profile's credentials are fetched on demand.
 *
 * The env is pi's own process env; an extension that edits it should emit AWS_ENV_CHANGED_EVENT.
 * Pure logic lives in ./resolve.ts (unit-tested); this file only registers the widget.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { registerWidget } from "../../halo/api.ts";
import { type IconLike, ICONS, iconSet } from "../../halo/icons.ts";
import { type AwsContext, EXPIRY_SOON_MS, formatRemaining, awsExpiresIn, resolveAwsContext, roleTone } from "./resolve.ts";

/** pi.events channel other extensions emit on after changing AWS env vars. */
export const AWS_ENV_CHANGED_EVENT = "aws-status:refresh";

// AWS orange, muted for a dark background.
const AWS_ORANGE = "#D4892A";

// The AWS logo (Nerd Font "fa-aws", U+F0EF, about 1.9 cells of ink in a one-cell slot) is the sidebar
// row's marker in place of the bullet. The footer draws the view's icon in front of the account, so
// its copy carries an extra space for the overhang. Without a Nerd Font the row keeps its bullet and
// the footer names the service in words instead (see icons.ts).
const LOGO: IconLike = { nerd: ICONS.widgetAws.nerd, plain: ICONS.widgetAws.plain };
const FOOTER_ICON: IconLike = { nerd: ICONS.widgetAwsFooter.nerd, plain: ICONS.widgetAwsFooter.plain };

/** A role name in its colour: read-only roles green, admin-style roles bold warning, others as given. */
function paintRole(theme: Theme, role: string): string {
	const tone = roleTone(role);
	if (tone === "read") return theme.fg("success", role);
	if (tone === "write") return theme.bold(theme.fg("warning", role));
	return role;
}

/** The footer's word for the service when there is no logo to show. The sidebar has its own title column. */
const footerLabel = (): string | undefined => (iconSet() === "plain" ? "AWS" : undefined);

export default function (pi: ExtensionAPI) {
	let current: AwsContext | undefined;
	const read = () => {
		const path = process.env.AWS_CONFIG_FILE || join(homedir(), ".aws", "config");
		let text: string | undefined;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			// no config: only env keys can apply
		}
		current = resolveAwsContext(process.env, text);
	};

	const handle = registerWidget(pi, {
		id: "aws",
		title: "AWS",
		icon: LOGO,
		order: 20,
		refreshMs: 30_000,
		update: read,
		render: ({ theme }) => {
			if (!current) return undefined;
			const tag = current.role ? paintRole(theme, current.role) : undefined;
			const left = awsExpiresIn(process.env);
			if (left !== undefined && left <= EXPIRY_SOON_MS) {
				return { icon: FOOTER_ICON, label: footerLabel(), text: `${current.account} (${formatRemaining(left)})`, tag, color: AWS_ORANGE, level: "warn" };
			}
			if (current.warning) return { icon: FOOTER_ICON, label: footerLabel(), text: `${current.account} (${current.warning})`, tag, color: AWS_ORANGE, level: "warn" };
			return { icon: FOOTER_ICON, label: footerLabel(), text: current.account, tag, color: AWS_ORANGE };
		},
		detail: ({ theme }) => {
			if (!current) return undefined;
			const lines: string[] = [];
			if (current.accountId && current.accountId !== current.account) lines.push(`id ${current.accountId}`);
			if (current.region) lines.push(`region ${current.region}`);
			const left = awsExpiresIn(process.env);
			if (left !== undefined) {
				const text = left <= 0 ? "credentials expired" : `expires in ${formatRemaining(left)}`;
				lines.push(left <= 0 ? theme.fg("error", text) : left <= EXPIRY_SOON_MS ? theme.fg("warning", text) : text);
			}
			return lines;
		},
	});

	pi.events.on(AWS_ENV_CHANGED_EVENT, () => handle.refresh());
}
