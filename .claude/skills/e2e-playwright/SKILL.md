---
name: e2e-playwright
description: Write and maintain the aure Playwright suite in apps/e2e. Covers API tests through the request fixture validated with @aure/contracts schemas, web tests through real browser flows with hydration-aware navigation and automatic console-error failure, running against the full stack from scripts/stack.mjs. Includes conventions for locators, test data isolation, flake prevention, regression tests for fixed bugs, and worked CRUD examples. Use this whenever tests need to be added, fixed, or run, whether turning a verified feature or a bug into an automated test, investigating a failing or flaky e2e test, or setting up coverage for a new resource or page.
---

# Playwright e2e suite

## Layout

```
apps/e2e/
  playwright.config.ts     projects: "api" (tests/api, no browser) and "web" (tests/web, Chromium)
  global-setup.ts          nothing running: starts a fresh stack and stops it after the run;
                           complete stack running: reuses it (serving the build it was started with);
                           partial stack: fails and tells you to run `stack.mjs up` or `down` first;
                           both E2E_API_URL and E2E_WEB_URL set: starts nothing (one alone, empty = unset, is an error);
                           DATABASE_URL set: refused unless E2E_ALLOW_EXTERNAL_DB=1 (tests write data; it gets migrated first)
  tests/api/*.spec.ts      import { test, expect } from "@playwright/test", use `request`
  tests/web/fixtures.ts    web `test` (fails on console errors), gotoHydrated()
  tests/web/*.spec.ts      import { test, expect, gotoHydrated } from "./fixtures"
```

Base URLs: API `http://localhost:3457`, web `http://localhost:3100`, the stack's defaults. Paths in tests are relative (`request.get("/api/orders")`, `gotoHydrated(page, "/orders")`).

## Running

```bash
pnpm test:e2e                                        # turbo: builds api + web, then the whole suite
PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e              # local: use installed Chrome, no browser download
pnpm --filter @aure/e2e test:api                     # one project
pnpm --filter @aure/e2e exec playwright test tests/web/orders.spec.ts -g "edits"   # one file / test
pnpm --filter @aure/e2e exec playwright test --repeat-each=3                        # flake check
pnpm --filter @aure/e2e exec playwright show-trace test-results/<test>/trace.zip    # failure trace
```

**Fast loop while writing tests:**
1. `pnpm turbo run build --force`
2. `node scripts/stack.mjs up --fresh`
3. Run `playwright test` directly as often as needed. Global setup reuses the running stack.
4. Rebuild and restart after app code changes.
5. `node scripts/stack.mjs down` at the end.

**Browsers:**
- **CI** needs `pnpm --filter @aure/e2e exec playwright install --with-deps chromium`.
- **Locally,** prefer `PLAYWRIGHT_CHANNEL=chrome` (or `msedge`). Downloading Playwright's browsers is a ~150 MB download, so ask before running `playwright install`.

`@aure/e2e#test` is never cached, and depends on the api and web builds.

## What to test where

- **API project:** status codes and the error contract (400 `issues` paths, 404, 409), plus response shapes. **Parse every success body with the contract schema** (`OrderSchema.parse(await res.json())`). That proves the shape, which a status check can't, and it catches API/contract drift. Add `"@aure/contracts": "workspace:*"` to devDependencies once the first resource exists.
- **Web project:** what a user does and sees. Navigation, forms (client validation, server errors shown, successful submit), loading/empty/not-found states, page titles, and that nothing logs a console error. Don't re-test every API edge case through the UI.
- **One flow per spec test** that reads like a user story. Prefer fewer, meaningful flows over many tiny assertions.

Worked examples (API CRUD + web CRUD flow, both run green): [references/crud-examples.md](references/crud-examples.md). Read them before writing tests for a new resource.

## Conventions that keep the suite reliable

- **Locators:** use what users perceive: `getByRole("button", { name })`, `getByLabel`, `getByRole("heading", { level: 1, name })`, `getByText` as a last resort.
  - If an element can't be found accessibly, that's usually an accessibility bug to report, not a reason for a `data-testid`.
  - You can't edit `apps/web`. If a test id is genuinely needed, request it in your report.
- **Hydration:** always navigate web tests with `gotoHydrated(page, url)`, never bare `page.goto` before interacting. Before hydration, forms submit natively and the test flakes.
- **Assertions:** use web-first assertions (`await expect(locator).toHaveText(...)`, `toHaveURL`, `toHaveCount(0)`), which retry. Never `waitForTimeout`, and never read a value then assert on it synchronously.
- **Data isolation:**
  - Every test creates its own data, with unique values (`crypto.randomUUID().slice(0, 8)` in names).
  - Never assume an empty database or a record count, and never depend on another test or on test order. The suite runs `fullyParallel`, and a reused stack has leftover data.
  - Seed through the API with `request` when the flow under test isn't creation itself.
- **Console errors:** web tests fail on any console error or page error. When one is expected (the document of a not-found page is a 404), scope an allowance: `test.use({ allowedConsoleErrors: [/status of 404/] })` inside a `describe`. Never globally.
- **Dates:** the UI formats in UTC, so assert exact strings. Use fixed input dates, never "now".
- **No retries or timeout bumps to hide flakes.** Find the race: usually missing `gotoHydrated`, a non-retrying assertion, or shared data. CI runs `retries: 2` with `failOnFlakyTests`, so a test that passes only on retry still fails the job; retries exist to capture a trace.
- **Infrastructure endpoints** without a contract schema (e.g. `/api/health`) assert the exact body, with a comment saying why.
- **After app changes, stop a reused stack** (`node scripts/stack.mjs down`), or the run tests the old build it was started with.
- **Under turbo** (`pnpm test:e2e`), every process the task started is killed when it ends, so a stack started by the tests never outlives the run. Start the stack yourself before running Playwright when you want to reuse it.

## When a test finds a product bug

You don't fix `apps/api` or `apps/web`. Keep the test asserting the **correct** behavior and mark it expected-to-fail with the reason:

```ts
test("rejects a negative quantity", async ({ request }) => {
  test.fail(true, "API accepts quantity -1 (bug reported to backend-developer)");
  // ...assert the correct 400...
});
```

`test.fail` keeps the suite green while the bug is open. Once someone fixes it, the test "unexpectedly passes" and fails the run, which forces the marker to be removed. Report the bug with reproduction steps and the owning agent.

## Done means

- `pnpm turbo run typecheck lint --filter=@aure/e2e --force` is clean.
- The new or changed specs pass three times in a row (`--repeat-each=3`) against a fresh stack.
- The full suite passes.
- The stack is stopped (`node scripts/stack.mjs status`).
