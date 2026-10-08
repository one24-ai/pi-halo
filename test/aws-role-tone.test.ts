/**
 * Run with:
 *   pnpm test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.PI_HALO_STATE = join(mkdtempSync(join(tmpdir(), "halo-")), "state.json");
// These tests check the Nerd Font glyphs; the plain set has its own tests in icons.test.ts.
process.env.PI_HALO_ICONS = "nerd";

const { roleTone } = await import("../extensions/widgets/aws/resolve.ts");
const api = await import("../extensions/halo/api.ts");
const { default: installAws } = await import("../extensions/widgets/aws/index.ts");
const { renderSidebar } = await import("../extensions/halo/sidebar.ts");
const { createState } = await import("../extensions/halo/state.ts");

test("roleTone: read-only names are read, admin-style names are write, the rest are neither", () => {
	for (const r of ["Dev-ReadOnly", "ReadOnlyAccess", "ViewOnlyAccess", "readonly", "Dev-Read-Only", "SecurityAudit-ViewOnly"]) {
		assert.equal(roleTone(r), "read", r);
	}
	for (const r of ["Platform-Admin", "AdministratorAccess", "PowerUserAccess", "Power-User", "FullAccess", "admin", "PLATFORM-ADMIN"]) {
		assert.equal(roleTone(r), "write", r);
	}
	for (const r of ["Dev", "Team_InfraOps", "Billing", "Engineer", "", undefined]) {
		assert.equal(roleTone(r), undefined, String(r));
	}
	// A name that says both is not safe to call read-only.
	assert.equal(roleTone("ReadOnly-Admin"), "write");
});

/** Real SGR codes with no width, so the sidebar's width maths matches a terminal's. */
const CODE: Record<string, number> = { success: 32, warning: 33, error: 31, muted: 90, dim: 90, text: 39, accent: 37 };
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const OFF = "\x1b[39m";

function recordingTheme() {
	return {
		fg: (c: string, t: string) => `\x1b[${CODE[c] ?? 39}m${t}${OFF}`,
		bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
		getColorMode: () => "truecolor",
	} as any;
}

/** The AWS row as the sidebar renders it (the role is drawn beside the account), for a given env. */
async function awsRoleLine(env: Record<string, string>): Promise<string> {
	const reg = api.getRegistry();
	for (const e of reg.widgets.values()) if (e.timer) clearInterval(e.timer);
	reg.widgets.clear();
	for (const k of ["AWS_PROFILE", "KC_ACCOUNT", "KC_ROLE", "AWS_ACCESS_KEY_ID", "AWS_CONFIG_FILE", "AWS_REGION", "AWS_DEFAULT_REGION", "PI_AWS_SESSION_EXPIRATION", "AWS_CREDENTIAL_EXPIRATION"]) delete process.env[k];
	Object.assign(process.env, env);
	installAws({ on: () => () => {}, events: { on: () => () => {} } } as any);
	reg.ctx = {} as any;
	api.refreshWidget("aws");
	await new Promise((r) => setTimeout(r, 10));
	const lines = renderSidebar(createState(), recordingTheme(), 42, 30, "1.0.0");
	return lines.find((l) => /AWS/.test(l)) ?? "";
}

test("sidebar: Dev-ReadOnly renders green beside the account, Platform-Admin bold warning, others plain", async () => {
	const cfg = join(mkdtempSync(join(tmpdir(), "aws-")), "config");
	(await import("node:fs")).writeFileSync(cfg, "[profile sso]\ncredential_process = /x/sso-creds\n[profile dev]\nrole_arn = arn:aws:iam::123456789012:role/Dev\n");
	const base = { AWS_CONFIG_FILE: cfg };

	// No resolver is registered in this package, so build the role from role_arn profiles instead.
	const ro = (await import("node:fs")).readFileSync(cfg, "utf8");
	(await import("node:fs")).writeFileSync(cfg, `${ro}[profile ro]\nrole_arn = arn:aws:iam::123456789012:role/Dev-ReadOnly\n[profile adm]\nrole_arn = arn:aws:iam::123456789012:role/Platform-Admin\n`);

	const read = await awsRoleLine({ ...base, AWS_PROFILE: "ro" });
	assert.ok(read.includes(`${GREEN}Dev-ReadOnly${OFF}`), JSON.stringify(read));

	const write = await awsRoleLine({ ...base, AWS_PROFILE: "adm" });
	assert.ok(write.includes(`\x1b[1m${YELLOW}Platform-Admin${OFF}\x1b[22m`), JSON.stringify(write));

	const other = await awsRoleLine({ ...base, AWS_PROFILE: "dev" });
	assert.ok(other.includes("Dev"), JSON.stringify(other));
	assert.ok(!other.includes(GREEN) && !other.includes(YELLOW), "an unclassified role keeps the line colour");
});

test("sidebar: the account name and other lines are not recoloured", async () => {
	const cfg = join(mkdtempSync(join(tmpdir(), "aws-")), "config");
	(await import("node:fs")).writeFileSync(cfg, "[profile adm]\nrole_arn = arn:aws:iam::123456789012:role/Platform-Admin\nregion = us-west-2\n");
	await awsRoleLine({ AWS_CONFIG_FILE: cfg, AWS_PROFILE: "adm" });
	const lines = renderSidebar(createState(), recordingTheme(), 42, 30, "1.0.0");
	const region = lines.find((l) => /region /.test(l)) ?? "";
	assert.ok(!region.includes(GREEN) && !region.includes(YELLOW) && !region.includes("\x1b[1m"), JSON.stringify(region));
	const row = lines.find((l) => /AWS/.test(l)) ?? "";
	assert.match(row.replace(/\x1b\[[0-9;]*m/g, ""), /AWS\s+adm Platform-Admin/, "the role follows the account on the same row");
	assert.ok(!/\x1b\[1m[^\x1b]*adm /.test(row.replace("Platform-Admin", "")), "the account name is not recoloured");
	assert.ok(!lines.some((l) => /role /.test(l)), "no separate role line");
});

test("awsExpiresIn and formatRemaining: countdown from AWS_CREDENTIAL_EXPIRATION", async () => {
	const { awsExpiresIn, formatRemaining } = await import("../extensions/widgets/aws/resolve.ts");
	const now = Date.parse("2030-01-01T12:00:00Z");
	const env = (exp?: string) => ({ AWS_ACCESS_KEY_ID: "ASIAX", ...(exp ? { AWS_CREDENTIAL_EXPIRATION: exp } : {}) });
	assert.equal(awsExpiresIn(env("2030-01-01T12:42:00Z"), now), 42 * 60_000);
	assert.equal(awsExpiresIn(env("2030-01-01T11:00:00Z"), now), -3_600_000);
	assert.equal(awsExpiresIn(env(), now), undefined);
	assert.equal(awsExpiresIn(env("later"), now), undefined);
	assert.equal(awsExpiresIn({ AWS_CREDENTIAL_EXPIRATION: "2030-01-01T12:42:00Z" }, now), undefined, "no keys, no countdown");
	// A switcher's session time works with a profile and no keys, and wins over a key expiry.
	assert.equal(awsExpiresIn({ AWS_PROFILE: "sso", PI_AWS_SESSION_EXPIRATION: "2030-01-01T12:30:00Z" }, now), 30 * 60_000);
	assert.equal(awsExpiresIn({ ...env("2030-01-01T12:42:00Z"), PI_AWS_SESSION_EXPIRATION: "2030-01-01T12:10:00Z" }, now), 10 * 60_000);
	assert.equal(awsExpiresIn({ PI_AWS_SESSION_EXPIRATION: "nope" }, now), undefined);
	assert.equal(formatRemaining(72 * 60_000), "1h 12m");
	assert.equal(formatRemaining(3_600_000), "1h 00m");
	assert.equal(formatRemaining(42 * 60_000 + 30_000), "42m");
	assert.equal(formatRemaining(20_000), "<1m");
	assert.equal(formatRemaining(0), "expired");
	assert.equal(formatRemaining(-5), "expired");
});

test("sidebar: the role sits beside the account on the AWS row, and the footer does not carry it", async () => {
	const cfg = join(mkdtempSync(join(tmpdir(), "aws-")), "config");
	(await import("node:fs")).writeFileSync(cfg, "[profile ro]\nrole_arn = arn:aws:iam::123456789012:role/Dev-ReadOnly\nregion = us-west-2\n");
	const row = await awsRoleLine({ AWS_CONFIG_FILE: cfg, AWS_PROFILE: "ro" });
	assert.match(row.replace(/\x1b\[[0-9;]*m/g, ""), /AWS\s+ro Dev-ReadOnly/);
	const view = api.getRegistry().widgets.get("aws")!.spec.render({ theme: recordingTheme(), ctx: undefined, width: 40 });
	assert.ok(view?.tag?.includes("Dev-ReadOnly") && !view.text?.includes("Dev-ReadOnly"), "the role is the tag, not part of the text the footer shows");
});
