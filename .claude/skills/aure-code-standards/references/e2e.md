# apps/e2e standards (Playwright 1.63)

## File structure

```
apps/e2e/
  playwright.config.ts        projects: api (tests/api), web (tests/web)
  global-setup.ts             stack lifecycle via scripts/stack.mjs
  tests/api/<resources>.spec.ts
  tests/web/fixtures.ts       web test (console-error failure), gotoHydrated
  tests/web/<resources>.spec.ts
```

- **One spec file per resource or page area,** named after it (`orders.spec.ts`, `home.spec.ts`).
- **`describe` titles** name the subject (`"orders API"`, `"orders pages"`). **Test titles** state behavior in plain language (`"rejects an empty patch, a malformed id and an unknown id"`), not implementation (`"test PATCH 400"`).

## Rules

| Rule | Severity if broken |
|---|---|
| No `test.only` / `describe.only` | blocker |
| Web specs import `test`/`expect` from `./fixtures`, never `@playwright/test` (loses console-error checks) | major |
| Web navigation uses `gotoHydrated(page, url)` before interacting | major |
| No `waitForTimeout` or other fixed sleeps; use web-first assertions (`await expect(locator).toBe…`) | major |
| Tests create their own uniquely named data; no dependence on order, other tests, or an empty database | major |
| API success bodies are parsed with the contract schema, not just status-checked. Infrastructure endpoints with no contract (e.g. `/api/health`) assert the exact body instead, with a comment | major |
| Locators are role- or label-based (`getByRole`, `getByLabel`); `data-testid` only with a stated reason; no CSS/XPath tied to layout (except `dt:text-is(…) + dd` pairs) | minor to major |
| `allowedConsoleErrors` is scoped to a `describe` for an expected error, never global | major |
| No added retries or timeouts to mask flakiness. The only retries are CI's suite-level `retries: 2` paired with `failOnFlakyTests: true` (traces get captured, flakes still fail the job) | major |
| Product bugs are captured with `test.fail(true, "<bug>")` asserting correct behavior, not a weakened assertion | major |
| Dates in assertions are fixed values, never "now" | minor |
| The suite never runs against an external database by accident: global setup refuses `DATABASE_URL` unless `E2E_ALLOW_EXTERNAL_DB=1` (and then migrates that database before the run); don't weaken that check | major |

## Coverage review points

- **API specs** cover the success path and the error contract (400 issue paths, 404, 409) for every endpoint changed.
- **Web specs** cover each user flow changed: happy path, validation errors, empty and not-found states.
- **No duplication:** don't re-test API edge cases through the UI, and don't write several tests that exercise the identical path.
- **A bug fix ships with a regression test,** or with a note explaining why one isn't feasible.
