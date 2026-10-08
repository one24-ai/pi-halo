# Releasing pi-halo

pi-halo has one source of truth and several places it is published to. The rule that keeps them
consistent: **every release is a commit on `main` with a `vX.Y.Z` tag, made once and pushed
unchanged everywhere.** No remote or registry gets a build the others don't have.

## Where it lives

| Place | What | Who uses it |
|---|---|---|
| `github.com/one24-ai/pi-halo` | The canonical repository: issues, pull requests, CI, tags | Everyone |
| npmjs.com, `pi-halo` | The published package, built and published by CI from a tag with npm trusted publishing | `pi install npm:pi-halo@X.Y.Z` |
| Any mirror (a company git server, a company npm registry) | A read-only copy of the same tags and the same tarball | People who can only reach that network |

Mirrors are downstream only. Changes are made in `github.com/one24-ai/pi-halo` and flow out; nothing is committed to a mirror directly. Code that is specific to one company does not go into pi-halo at all: it lives in a separate package that depends on pi-halo (a brand, extra widgets, internal tools).

## Versions

Semantic versioning, as described in the README's [Versioning](README.md#versioning) section. While the version is 0.x, a breaking change bumps the minor version.

Every change that a user could notice gets a line under `## [Unreleased]` in `CHANGELOG.md`, in the same commit or pull request as the change, under `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security`. The release script refuses to cut a release while that section is empty.

## Cut a release

```bash
pnpm release patch          # or minor, major, or an exact version such as 0.2.0
pnpm release minor --dry-run
```

`pnpm release` checks that the tree is clean and on `main`, runs `pnpm check`, bumps `package.json`, moves the Unreleased entries under the new version with today's date, commits `Release X.Y.Z` and creates the annotated tag `vX.Y.Z`. It does not push or publish.

Then:

```bash
git push origin main --follow-tags
```

The tag starts `.github/workflows/release.yml`, which runs the checks again, verifies the tag matches `package.json`, publishes to npm, and creates the GitHub release from the changelog entry.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC): no npm token is stored in GitHub. npm accepts the run because the package's trusted publisher names this repository, `release.yml` and the `npm` environment, and it adds a provenance attestation on its own. If a release run fails at `npm publish` with a 404 or 403, check those three names on npmjs.com first: they must match exactly.

## Mirrors

Add each mirror as its own git remote and push the same commits and tags to it after the release has published:

```bash
git remote add mirror <url>          # once
git push mirror main --follow-tags   # after each release
```

To put the package in a second npm registry, publish the tarball CI built, not a new build, so both registries serve identical bytes:

```bash
npm pack pi-halo@X.Y.Z                                  # the exact tarball from npmjs.com
npm publish pi-halo-X.Y.Z.tgz --registry <registry-url>
```

A registry that proxies npmjs.com (most company registries do) needs nothing: `pi install npm:pi-halo@X.Y.Z` through it gets the public package.

## One-time setup

These were done once, when 0.1.0 was published, and are recorded here in case they need redoing.

1. **First publish by hand.** npm can only attach a trusted publisher to a package that already exists, so the first version was published from a maintainer's machine with 2FA, from the tag:

   ```bash
   git checkout v0.1.0 && pnpm install --frozen-lockfile && pnpm check
   npm publish --provenance=false   # prompts for the 2FA code
   ```

2. **Trusted publisher.** On npmjs.com, package `pi-halo`, Settings, Trusted Publisher, GitHub Actions: organization `one24-ai`, repository `pi-halo`, workflow `release.yml`, environment `npm`. Or, with npm 11.15 or later and 2FA:

   ```bash
   npm trust github pi-halo --file release.yml --repo one24-ai/pi-halo --env npm --allow-publish
   ```

   A new trusted publisher must complete its first publish within 2 days, so cut the next release soon after.

3. **No tokens.** Do not add an npm token to the repository. npm is retiring 2FA-bypass tokens for publishing (planned for January 2027), and trusted publishing does not need one.

4. **GitHub.** `main` requires the CI check and cannot be force-pushed or deleted. `v*` tags can only be created, moved or deleted by admins, because pushing one publishes. The `npm` environment only runs for `v*.*.*` tags.
