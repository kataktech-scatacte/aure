---
name: aure-code-standards
description: The aure monorepo's code standards and review procedure. Covers tech-stack rules (NestJS API, TanStack Start web app, zod contracts, raw pg data layer, Playwright e2e), naming, file structure, import boundaries, error handling, dependencies and config, with a checker script for the mechanical rules. Use this when reviewing code, a diff, a branch or a PR in this repo; when checking whether new code follows project conventions ("does this match our standards?", "review my changes", "is this named/structured right?"); or when deciding where a new file goes and what to call it.
---

# aure code standards

These standards describe how code in this repo is **already** written: by the scaffold scripts, enforced by lint and typecheck, or learned from real bugs. Every rule has a reason. When the code and a rule disagree, the reason decides which one should change.

## Review procedure

1. **Define the scope.** Given paths review those. Given a PR or branch, diff against its base. Otherwise use uncommitted and untracked changes (`git status`). Note that until the repo's first commit, "changed" means every file.
2. **Run the mechanical checks first,** so judgment time goes where it's needed:

   ```bash
   node .claude/skills/aure-code-standards/scripts/check-standards.mjs [paths...|--all]
   pnpm turbo run typecheck lint --force
   ```

   The checker covers naming, file placement, web/API boundaries, `import type` on injected classes, SQL interpolation, deprecated zod 4 APIs, `any`, `console`, unexplained `eslint-disable`, migration names, e2e anti-patterns and dependency specifiers. Treat its findings as candidates. Confirm each in context before reporting it. If typecheck fails on new routes, run `pnpm turbo run build --force` first to regenerate `routeTree.gen.ts`.
3. **Read the changed code** against the reference for each area it touches. Load only the files you need:

   | Area touched | Read |
   |---|---|
   | `apps/api/**` | [references/api.md](references/api.md) |
   | `packages/contracts/**`, `packages/db/**`, `packages/api-client/**` | [references/contracts-db-client.md](references/contracts-db-client.md) |
   | `apps/web/**` | [references/web.md](references/web.md) |
   | `apps/e2e/**` | [references/e2e.md](references/e2e.md) |
   | `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig`, eslint config, new packages, `scripts/` | [references/workspace.md](references/workspace.md) |

   Always apply the cross-cutting rules below.
4. **Look past style.** Standards are the floor. Also review for:
   - correctness: logic, edge cases, error paths, null handling
   - security: authorization, injection, secrets reaching the browser
   - data integrity: constraints, transactions, migrations
   - contract drift between the API and the web app
   - accessibility
   - missing states
   - simplicity: dead code, duplication, needless abstraction
5. **Report** in the format below. Don't fix anything.

## Cross-cutting rules (all TypeScript)

**Naming**

| Thing | Convention | Example |
|---|---|---|
| Files and folders | kebab-case; dot-suffix for a role | `order-form.tsx`, `orders.service.ts`, `zod-validation.pipe.ts` |
| Framework-reserved file names | as the framework requires | `__root.tsx`, `$id/`, `routeTree.gen.ts` |
| Types, interfaces, classes, React components | PascalCase, no `I`/`T` prefixes | `OrderRow`, `OrdersService`, `OrderForm` |
| Functions, variables, methods | camelCase, verbs for functions | `toOrderInsert`, `listOrders` |
| Module-level constants, DI tokens, SQL fragments | UPPER_SNAKE_CASE | `PG_POOL`, `COLUMNS`, `PG_UNIQUE_VIOLATION` |
| zod schemas / inferred types | `<Name>Schema` / `<Name>` | `CreateOrderSchema` / `CreateOrderInput` |
| Booleans | read as a question | `submitting`, `isPgError`, `confirming` |
| Resources | plural kebab for routes, dirs and tables (snake_case in SQL); singular PascalCase for entities | `/api/line-items`, `line_items`, `LineItem` |

Names say what something is in the domain, not how it's implemented. Avoid `data`, `info`, `helper`, `utils`, `manager`, `handleStuff`.

**Code**
- **Strict TypeScript is on:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. No `any`: use `unknown` and narrow. No non-null `!` unless an invariant makes it safe, with a comment saying why. Never cast to silence an error.
- **Exported functions and React components declare return types.** Factories that return an object literal may infer, and export `type X = ReturnType<typeof createX>`.
- **Model states with discriminated unions** (`MutationResult`: `{ ok: true, value } | { ok: false, … }`), not bags of optional fields. Exhaustive `switch` statements end with a `never` check.
- **Validate at boundaries with zod** (HTTP input, API responses, env, URL search params). Inside the boundary, trust the types.
- **Don't mutate parameters.** Building a local array or object inside a function is fine.
- **Comments explain *why*,** not what. Give JSDoc to exported functions whose contract isn't obvious from the name and types. Delete commented-out code.
- **No `console.log` in source.** The API uses Nest's `Logger`; the web app logs nothing.
- **`eslint-disable` only with a reason:** `// eslint-disable-next-line <rule> -- <why>`. Never for import-boundary rules. Never hand-edit generated files (`routeTree.gen.ts`).
- **Formatting** (no formatter is configured, so match the surrounding code): double quotes, semicolons, trailing commas, 2-space indent.
- **Import groups,** separated by a blank line: external and `@aure/*` packages first, then relative imports. In packages under `packages/` and in `apps/web`, type-only imports use `type` (`verbatimModuleSyntax`). `apps/api` has its own rule; see api.md.
- **One responsibility per file.** Files past ~250 lines usually need splitting along a real seam.

## Severity

- **blocker:** must be fixed before merge. Covers breaking the architecture (import boundaries, the browser reaching the API), security or data-integrity risk (SQL injection, missing authorization, secrets in the client bundle, editing an applied migration), guaranteed runtime failure (DI `import type`), or `test.only`.
- **major:** should be fixed in this change. Covers violating a stack standard with real consequences: wrong layer or placement, missing error or empty state, breaking contract change without a handoff, hydration risk, flaky test patterns, naming or structure that misleads.
- **minor:** fix when convenient. Covers deprecated APIs, a missing reason on `eslint-disable`, small naming inconsistencies, comments.
- **nit:** optional polish, clearly labeled. Keep these few.

## Report format

```
## Review: APPROVE | REQUEST CHANGES | COMMENT
<scope reviewed: paths / diff range, file count> · checker: N findings · typecheck/lint: pass|fail

## Findings
### [blocker|major|minor|nit] <short title>
`path/to/file.ts:42` · rule: <checker rule id or standard section>
<what is wrong and why it matters, one to three sentences>
Suggested fix: <concrete change, small snippet if it helps>
Owner: backend-developer | frontend-developer | test-engineer

## Standards gaps
<patterns in this change that no standard covers yet; propose a rule or ask>

## Good
<one to three things done well worth repeating. Skip if nothing stands out.>
```

**Verdict:** REQUEST CHANGES for any blocker or major finding, APPROVE for minor findings or nits only, COMMENT when the review couldn't complete (say why). Order findings by severity, then by file. Group repeats of the same issue into one finding that lists every location.
