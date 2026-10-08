/**
 * Pure AWS context resolution (no pi imports, so tests run standalone).
 *
 * Understands env keys, role_arn and SSO profiles. A `credential_process` is opaque to it unless a
 * resolver claims the command (see registerCredentialProcessResolver), so credential tools such as
 * an SSO wrapper can say which account a profile really points at.
 */

export interface AwsContext {
	/** Short account label: alias/name, or the 12-digit ID when that's all we know. */
	account: string;
	accountId?: string;
	role?: string;
	/** Where it came from, e.g. "profile dev" or "env keys". */
	source: string;
	/** Configuration problem worth flagging (e.g. a profile whose credential tool is not set up). */
	warning?: string;
	/** Effective region: AWS_REGION > AWS_DEFAULT_REGION > profile region (> a resolver's region). */
	region?: string;
}

type Env = Record<string, string | undefined>;

/** What a resolver learns about a profile's `credential_process`. */
export interface CredentialProcessCall {
	/** The command's basename, e.g. "aws-vault". */
	bin: string;
	/** The whole command line split like botocore does, `bin` first. */
	args: string[];
	env: Env;
	profile: string;
}

/** What a resolver reports. `region` is used only when nothing more specific sets one. */
export interface CredentialProcessResult {
	account: string;
	role?: string;
	warning?: string;
	region?: string;
}

/** Return undefined to pass. The first resolver that answers wins. */
export type CredentialProcessResolver = (call: CredentialProcessCall) => CredentialProcessResult | undefined;

const RESOLVERS = Symbol.for("pi-halo/aws-credential-process-resolvers");

function resolvers(): CredentialProcessResolver[] {
	const g = globalThis as unknown as Record<symbol, CredentialProcessResolver[] | undefined>;
	g[RESOLVERS] ??= [];
	return g[RESOLVERS]!;
}

/**
 * Teach the AWS widget about a credential tool. It lives on globalThis so another package can call
 * it whichever extension loads first. Returns a function that removes the resolver.
 */
export function registerCredentialProcessResolver(fn: CredentialProcessResolver): () => void {
	resolvers().push(fn);
	return () => {
		const list = resolvers();
		const i = list.indexOf(fn);
		if (i >= 0) list.splice(i, 1);
	};
}

/** Internal: a context plus the fallback region a resolver gave. */
type Resolved = AwsContext & { fallbackRegion?: string };
type Profiles = Map<string, Map<string, string>>;

/** Minimal INI parser for ~/.aws/config: "[default]" and "[profile name]" sections. */
export function parseAwsConfig(text: string): Profiles {
	const profiles: Profiles = new Map();
	let current: Map<string, string> | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const section = line.match(/^\[\s*(?:profile\s+)?([^\]]+?)\s*\]$/);
		if (section) {
			current = new Map();
			profiles.set(section[1], current);
			continue;
		}
		const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/);
		if (kv && current) current.set(kv[1].toLowerCase(), kv[2]);
	}
	return profiles;
}

/**
 * Account ID encoded in an AWS access key ID (AKIA/ASIA...). This is a documented
 * property of the key format and needs no network call.
 */
export function accountFromAccessKeyId(keyId: string): string | undefined {
	if (!/^(AKIA|ASIA)[A-Z2-7]{16}$/.test(keyId)) return undefined;
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = 0n;
	for (const ch of keyId.slice(4)) bits = (bits << 5n) | BigInt(alphabet.indexOf(ch));
	// 16 base32 chars = 80 bits; the first 6 bytes (48 bits) hold the account ID << 7.
	const first6 = bits >> 32n;
	const id = (first6 & 0x7fffffffff80n) >> 7n;
	return id.toString().padStart(12, "0");
}

/** Split a credential_process command line the way botocore does (no shell, basic quotes). */
function splitArgs(cmd: string): string[] {
	return (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, "$2"));
}

const hasCredentialSource = (p: Map<string, string>) =>
	["credential_process", "role_arn", "sso_account_id", "sso_session", "aws_access_key_id", "web_identity_token_file"].some(
		(k) => p.has(k),
	);

function fromProfile(name: string, p: Map<string, string> | undefined, env: Env): Resolved {
	const source = `profile ${name}`;
	if (!p) return { account: name, source, warning: `profile "${name}" not found in AWS config` };

	const roleArn = p.get("role_arn")?.match(/^arn:aws[\w-]*:iam::(\d{12}):role\/(?:.*\/)?([^/]+)$/);
	if (roleArn) return { account: name, accountId: roleArn[1], role: roleArn[2], source };

	if (p.has("sso_account_id")) {
		return { account: name, accountId: p.get("sso_account_id"), role: p.get("sso_role_name"), source };
	}

	const cp = p.get("credential_process");
	if (cp) {
		const args = splitArgs(cp);
		const call = { bin: (args[0] ?? "").split("/").pop() ?? "", args, env, profile: name };
		for (const resolve of [...resolvers()]) {
			let r: CredentialProcessResult | undefined;
			try {
				r = resolve(call);
			} catch {
				continue; // a broken resolver must not take the widget down
			}
			if (r) return { account: r.account, role: r.role, warning: r.warning, source, fallbackRegion: r.region };
		}
	}
	return { account: name, source };
}

/** Effective region for a profile, in the AWS SDK's precedence order. */
export function resolveRegion(env: Env, profile: Map<string, string> | undefined, fallback?: string): string | undefined {
	return (
		env.AWS_REGION?.trim() ||
		env.AWS_DEFAULT_REGION?.trim() ||
		profile?.get("region") ||
		fallback?.trim() ||
		undefined
	);
}

/** Work out which AWS account the given env + config point at, without any network calls. */
export function resolveAwsContext(env: Env, configText: string | undefined): AwsContext | undefined {
	const c = resolveAccount(env, configText);
	if (!c) return undefined;
	const { fallbackRegion, ...context } = c;
	const profiles = parseAwsConfig(configText ?? "");
	const name = c.source.startsWith("profile ") ? c.source.slice("profile ".length) : undefined;
	const profile = name ? profiles.get(name) : undefined;
	return { ...context, region: resolveRegion(env, name ? profile : profiles.get("default"), fallbackRegion) };
}

function resolveAccount(env: Env, configText: string | undefined): Resolved | undefined {
	const keyId = env.AWS_ACCESS_KEY_ID?.trim();
	if (keyId) {
		const id = accountFromAccessKeyId(keyId);
		return { account: id ?? "env keys", accountId: id, source: "env keys" };
	}
	const profiles = parseAwsConfig(configText ?? "");
	const named = (env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE)?.trim();
	if (named) return fromProfile(named, profiles.get(named), env);
	const def = profiles.get("default");
	if (def && hasCredentialSource(def)) return fromProfile("default", def, env);
	return undefined;
}

/**
 * How a role name reads: "read" for read-only roles (ReadOnlyAccess, ViewOnlyAccess, Dev-ReadOnly),
 * "write" for roles that name broad write access (AdministratorAccess, PowerUserAccess, Platform-Admin),
 * undefined for anything else. Judged from the name alone, so it is a hint for colouring and not
 * a statement about what the role's policy allows. A name that says both counts as "write".
 */
export function roleTone(role: string | undefined): "read" | "write" | undefined {
	if (!role) return undefined;
	if (/admin|power-?user|full-?access/i.test(role)) return "write";
	if (/read-?only|view-?only/i.test(role)) return "read";
	return undefined;
}

/** Inside this many milliseconds of expiry the widget warns. */
export const EXPIRY_SOON_MS = 10 * 60_000;

/**
 * Env var a credential switcher (a command that changes the active AWS session) sets to the ISO time its session's
 * credentials end. It is not a secret and holds no keys. The switcher owns what happens then.
 */
export const SESSION_EXPIRY_VAR = "PI_AWS_SESSION_EXPIRATION";

/**
 * Milliseconds until the AWS credentials expire (negative once past). Reads SESSION_EXPIRY_VAR
 * first, else AWS_CREDENTIAL_EXPIRATION when env keys are set. Undefined when neither gives a
 * readable time. A profile's own credentials are fetched on demand, so they have no known expiry
 * unless a switcher records one.
 */
export function awsExpiresIn(env: Env, now: number = Date.now()): number | undefined {
	const raw = env[SESSION_EXPIRY_VAR]?.trim() || (env.AWS_ACCESS_KEY_ID?.trim() ? env.AWS_CREDENTIAL_EXPIRATION?.trim() : undefined);
	const t = Date.parse(raw ?? "");
	return Number.isNaN(t) ? undefined : t - now;
}

/** "1h 12m", "42m", "<1m" or "expired". */
export function formatRemaining(ms: number): string {
	if (ms <= 0) return "expired";
	const min = Math.floor(ms / 60_000);
	if (min < 1) return "<1m";
	return min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m` : `${min}m`;
}

export function formatAwsStatus(c: AwsContext): string {
	const parts = [c.account];
	if (c.role) parts.push(c.role);
	if (c.accountId && c.accountId !== c.account) parts.push(c.accountId);
	if (c.region) parts.push(c.region);
	return parts.join("·");
}
