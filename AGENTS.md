# pi-halo: notes for agents working in this repo

- This is a general-purpose package. Nothing specific to one company, its hosts, services, colours or tools goes in code, docs, tests or examples. That belongs in a separate package that depends on pi-halo.
- Use pnpm, never npm or yarn. `pnpm check` runs the tests and the type check; run it before saying a change is done.
- Every change a user could notice gets a line under `## [Unreleased]` in `CHANGELOG.md` in the same commit (Added, Changed, Deprecated, Removed, Fixed, Security). Say if it is breaking.
- Versions follow semver as described in the README's Versioning section. Do not edit `version` in package.json by hand; `pnpm release` does it. Releases are cut and pushed by the owner (see RELEASING.md).
- No em dashes anywhere.
