# Workspace standards (pnpm 12, Turborepo, TypeScript 6.0)

## Layout

```
apps/api          @aure/api         NestJS (CommonJS)
apps/web          @aure/web         TanStack Start (ESM)
apps/e2e          @aure/e2e         Playwright
packages/contracts, db, api-client  @aure/<name>  libraries (tsup, dual ESM+CJS)
packages/config-ts, config-eslint   shared configs (consumed as source)
scripts/          repo tooling in plain .mjs (stack.mjs)
.claude/          agents and skills (not product code)
```

New code goes in an existing workspace unless a new package has a real consumer boundary. A new package needs a stated reason in review.

## Dependencies

- **Specifiers are exactly one of:** `"catalog:"` (anything shared, or likely to be), an exact pin (`"19.3.0"`; used for React and Nest), or `"workspace:*"`. No ranges (`^`, `~`, `*`, `latest`); the checker flags them.
- **Versions** live in the `catalog:` in `pnpm-workspace.yaml` as exact versions (overrides too; no `^`/`~` there either), grouped under the existing comment headings, and must be older than 24h (`minimumReleaseAge`). Use the `upgrade-dependency` skill's `mature-versions.mjs`.
- **Lockstep packages** stay identical: all `@nestjs/*`, `react`/`react-dom`/`@types/react*`, `@tanstack/react-start` with `@tanstack/react-router`.
- **pnpm settings** (overrides, `allowBuilds`, `engineStrict`) live in `pnpm-workspace.yaml`. pnpm 12 ignores the `pnpm` field in `package.json` and pnpm settings in `.npmrc`.
- **Native or postinstall dependencies** need an `allowBuilds` entry, or they silently never build.
- **New dependencies:** each needs a reason (what it replaces or enables) and must not duplicate something already in the stack. New ORMs, UI kits, styling or data-fetching libraries are blockers without a recorded decision.
- **`pnpm-lock.yaml`** changes only alongside a matching `package.json` or catalog change.

## Package setup (libraries)

`package.json`:
- `"private": true`, `"type": "module"`
- dual `exports` (`import` → `.js`/`.d.ts`, `require` → `.cjs`/`.d.cts`)
- scripts `build` (tsup), `typecheck` (`tsc --noEmit`), `lint` (`eslint .`)
- a `tsup` field with `dts: { compilerOptions: { ignoreDeprecations: "6.0" } }`

`tsconfig.json`:
- extends `@aure/config-ts/library.json` (or `nest.json`/`start.json` for apps)
- `include: ["src"]`

`eslint.config.mjs`:
- re-exports `@aure/config-eslint/base` (or `nest`/`start`)
- rules are added in `packages/config-eslint`, not per package

## Config files

- **`turbo.json`:**
  - Env vars read at runtime go in `globalPassThroughEnv` (e.g. `DATABASE_URL`, `API_URL`, `E2E_*`). Vars that change build output go in `env` for that task.
  - An undeclared env var fails lint (`turbo/no-undeclared-env-vars`), and one silently missing from a task's environment is a runtime bug.
  - Test tasks that hit live services set `"cache": false`.
- **TypeScript:**
  - Stays pinned at 6.0.x (Nest CLI and typescript-eslint cap it). Strictness flags in `base.json` are never relaxed per package.
  - Per-package `compilerOptions` overrides need a comment explaining why (see `nest.json`'s `verbatimModuleSyntax: false`).
- **ESLint:** rules are relaxed only in the shared config, with a comment (see `start.js`'s `only-throw-error` allowance for TanStack's `notFound()`/`redirect()`).
- **Node:** the `engines` range in the root `package.json` mirrors the strictest dependency (currently the Nest CLI 12 toolchain: `^22.22.3 || ^24.15.0 || >=26`).
- **`.gitignore`** covers every generated output (`dist/`, `.output/`, `.tanstack/`, `.stack/`, Playwright reports).

## scripts/*.mjs

- Node built-ins only, with a usage comment at the top.
- Fail with a clear message and a non-zero exit code; never leave background processes behind. Scripts that start detached processes clean them up on failure **and** on SIGINT/SIGTERM (Ctrl+C, CI cancellation). The signal handler only sets a flag, and the main flow stops at its next step and runs the single cleanup path, so nothing is started after cleanup has run. A second signal exits immediately. Exit with 128 + signal number.
- Never trust state persisted on disk (PIDs, flags) to decide what to kill; re-verify ownership at the moment of acting, since PIDs are reused.
- Must work on Windows and POSIX (paths via `node:path`, no shell-specific syntax).
