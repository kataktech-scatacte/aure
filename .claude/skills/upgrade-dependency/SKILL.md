---
name: upgrade-dependency
description: Upgrade, bump, or pin npm packages in the aure pnpm/Turborepo monorepo. Picks the newest version that pnpm's 24h minimumReleaseAge gate allows, checks peer and Node engine compatibility in both directions, updates the pnpm catalog or direct pins, and verifies with install, peers check, build, typecheck and lint. Use this whenever the user asks to upgrade, update, bump, or move a package to a new major (e.g. "upgrade eslint to 10", "bump vite", "update react", "are our deps out of date", "move to the latest nest"). Also use it when adding a new dependency that needs a version pinned, or when an install fails on minimumReleaseAge or unmet peers.
---

# Upgrade a dependency

This repo makes upgrades fail in quiet ways:
- Exact pins sit in two places: the `catalog:` in `pnpm-workspace.yaml`, plus a few direct pins in app `package.json`s (react, nest).
- `minimumReleaseAge` blocks anything published in the last 24h.
- `engineStrict: true` in `pnpm-workspace.yaml` turns a dependency's Node engines mismatch into a hard install failure. pnpm 12 ignores the old `.npmrc` setting.
- Overrides pin TypeScript for the whole tree.

The workflow below works around each of these. Don't skip the checks. "It installed" is not the same as "it works".

## 1. Find the candidate version

Run the bundled script from the repo root, and include companion packages that move together:

```bash
node .claude/skills/upgrade-dependency/scripts/mature-versions.mjs eslint @eslint/js typescript-eslint
```

For each package it shows:
- where the package is pinned
- the newest version the age gate allows, ranked by semver
- anything newer that is still blocked
- that version's peers and `engines.node`

Pass `pkg@x.y.z` to inspect one specific version.

Don't pick versions by "most recently published". Maintenance lines ship after new majors (`@eslint/js` 9.39.5 came out after 10.0.1). Don't pin a version the script lists as blocked either, because `pnpm install` will reject it.

**Companions:** packages that share a major or release in lockstep upgrade together. Examples:
- `eslint` with `@eslint/js`
- `@nestjs/*`
- `react` with `react-dom` and `@types/react*`
- `@tanstack/react-start` with `@tanstack/react-router`
- `vite` with `@vitejs/plugin-react`

If a companion has no mature release on the new major yet, stop and tell the user. Don't mix majors.

**Prereleases:** only use one when stable doesn't exist and the ecosystem uses it anyway (e.g. `nitro` date-stamped betas). The script follows the prerelease line automatically when the `latest` dist-tag is one, and prints a NOTE when it does. Add a catalog comment saying why.

## 2. Check compatibility in both directions

**What the new version needs:**
- Every non-optional peer must be satisfied by what's installed.
- `engines.node` must be satisfied by root `package.json` `engines.node`. If the new floor is higher, raise the root `engines` field to match. `engineStrict` enforces dependency engines at install time, but not the root field itself, so keeping root `engines` in sync is on you. This includes transitive dependencies: `@nestjs/cli` 12's Angular DevKit pins are what set the current floor.
- The pinned TypeScript (see `overrides` in `pnpm-workspace.yaml`) must be in range. Several tools cap TypeScript, and the override exists for that reason.

**What depends on it:** find workspace packages that peer on the target. Check their current versions with the script (it prints peers):
- For a lint tool: `typescript-eslint`, `eslint-config-turbo`, the eslint plugins in `packages/config-eslint`.
- For a build tool: its plugins.

If a dependent's peer range excludes the new version, see whether a mature release of that dependent widens it. If none does, stop and report the blocker, naming the package and its range. Don't paper over it with overrides or `--force`.

For a new major, skim the release notes or migration guide for changes that affect this repo:
- config format changes
- removed APIs
- dropped Node versions
- changed defaults

This is the check that catches breakage the build won't.

## 3. Apply

- **Catalog entries:** edit the value in `pnpm-workspace.yaml`. Workspaces reference `"catalog:"`, so nothing else changes.
- **Direct pins:** edit every `package.json` that pins it, and keep companions identical.
- **Comments:** re-read the ones next to the entries you touched. Catalog comments often explain why something was held back (e.g. "ESLint stays on 9.x because…"). If the upgrade removes that reason, delete or rewrite the comment. A stale justification misleads the next person.
- **Native builds:** if the new version adds a native or postinstall dependency, add it to `allowBuilds`. If it drops one, remove the stale entry. Otherwise native binaries silently never build.

## 4. Verify

Run these from the repo root:

```bash
pnpm install
pnpm peers check
pnpm turbo run build typecheck lint --force
```

- Use `--force` so Turbo cache hits can't hide a failure.
- Scan the `pnpm install` output for age-gate rejections, ignored builds, and deprecation warnings.
- Confirm only one copy resolved. Two versions usually mean a dependent still pins the old one.

  ```bash
  grep -oE "^  <pkg>@[^:(]+" pnpm-lock.yaml | sort -u
  ```

- Check that the tool still does its job, not just that it exits 0. For a linter, write a throwaway file that breaks a repo rule, lint it, confirm the error, then delete the file. `apps/web` importing `pg` should trigger the Postgres import ban. For a runtime or framework, start the built app and hit it (web: `pnpm --filter @aure/web start`; api: `GET /api/health`).

If verification fails, fix it or revert the version change. Don't leave the repo half-upgraded.

## 5. Report

Tell the user:
- the version change (old to new) for each package
- anything else that had to move (engines, companions, comments, `allowBuilds`)
- any package held back and why (age gate, peer cap)
- the checks run and their results
