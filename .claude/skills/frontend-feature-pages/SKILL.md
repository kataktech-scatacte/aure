---
name: frontend-feature-pages
description: Build web UI for an API resource in apps/web (TanStack Start, React 19). Covers the packages/api-client methods, server functions that call the API, and CRUD routes (list with pagination, detail, create and edit forms, delete) with pending, error, not-found and empty states, head tags and accessible forms validated by the shared zod contract, verified in a real browser against the running API. Includes a scaffold script that reads field types from the built @aure/contracts schemas. Use this whenever the web app needs pages or forms for data the API serves ("show orders in the web app", "add a customers page", "users need to edit invoices"), when picking up a backend-developer handoff, or when adding api-client methods.
---

# Frontend feature pages

A web feature in aure has three layers. Only the server layer talks to the API:

```
packages/api-client          typed fetch client, validates responses with contract schemas
apps/web/src/server/<res>.ts server functions: createServerFn -> api-client (always server-side)
apps/web/src/routes/<res>/   loaders + components call the server functions, never the client
```

This is why it's built that way:
- **Browsers can't call the API.** It has no CORS and its URL (`API_URL`) isn't public.
- **Loaders are isomorphic.** They run on the server during SSR and in the browser on client navigation.
- **Server functions always execute on the server,** so they're the one safe bridge. Build output confirms nothing leaks: the client bundle contains no `API_URL` or api-client code.

**Scope:**
- `apps/web` and `packages/api-client` are the work.
- `packages/contracts` is read-only. If the UI needs a different shape, hand that back to the backend.

## 1. Check the contract exists

The API resource must exist first, normally from the `backend-feature-slice` scaffold: `packages/contracts/src/<res>.ts` with `<Entity>Schema`, `Create<Entity>Schema`, `Update<Entity>Schema` and `<Entity>ListSchema`.

The scaffold reads the **built** contracts, so build them first:

```bash
pnpm --filter @aure/contracts build
```

## 2. Scaffold

Run from the repo root:

```bash
node .claude/skills/frontend-feature-pages/scripts/scaffold-pages.mjs line-items --singular line-item
```

Add `--dry-run` to preview. The script:
- never overwrites existing files, so re-running is safe
- prints the field types it detected. Check them: e.g. `quantity:int`, `dueAt:date?`, `status:enum[open|paid]`
- prints **ACTION NEEDED** for fields it can't render (arrays, objects, anything beyond string/int/number/boolean/date/uuid/email/enum)

It generates:
- **`packages/api-client/src/<res>.ts`** with list/get/create/update/remove, registered in the client. On first use it also bootstraps the package, built with tsup to dual ESM + CJS.
- **`apps/web/src/server/<res>.ts`**: server functions. `get` turns an API 404 into `notFound()`. Mutations return a `MutationResult` (`{ ok: true, value }` or `{ ok: false, status, message, issues }`) instead of throwing, so forms can show API validation errors.
- **Routes:**
  - `/<res>`: table, pagination through `limit`/`offset` search params (defaults stripped from the URL), empty state
  - `/<res>/new`: create form
  - `/<res>/$id`: detail, and delete with an inline confirm step
  - `/<res>/$id/edit`: edit form that PATCHes only changed fields; "no changes" shows a form error
- **Shared pieces** (first use only): `src/server/api.ts`, `src/components/route-states.tsx` (pending/error/not-found), `src/lib/format.ts`
- **Config:** `@aure/api-client`, `@aure/contracts` and `zod` dependencies in `apps/web`, `"node"` types for `process.env`, and the `API_URL` pass-through in `turbo.json`

Then install:

```bash
pnpm install
```

## 3. Make it real

The scaffold is a correct, accessible baseline, not the finished UI.

- **List columns:** the scaffold picks the first plain string field as the link text, plus up to three other fields. Choose what users actually scan for.
- **Display formatting:**
  - Money stored in minor units (`priceCents`) should render as currency, e.g. `Intl.NumberFormat("en", { style: "currency", currency, timeZone: "UTC" })`.
  - Enum values need human labels.
  - Keep every date format fixed to UTC, as `src/lib/format.ts` does. Formatting with the server's or browser's local timezone renders differently in SSR and hydration, and React reports a hydration mismatch.
- **Form fields:**
  - Replace raw uuid text inputs (foreign keys like `customerId`) with a select or search fed by another server function.
  - Hide fields users shouldn't set.
  - Add help text with `aria-describedby`.
- **Navigation:** the scaffold doesn't touch `__root.tsx`. Add a link to the new section where the app's navigation lives.
- **Auth and redirects:** guard routes in `beforeLoad` with `throw redirect({ to: "/login" })`. Lint allows throwing `notFound()` and `redirect()`.
- **Styling:** there's no styling system yet. Keep markup semantic and class-free, or ask before introducing one.

## Rules that keep it correct

- **Validate forms with the contract schema** (`Create…Schema` / `Update…Schema`) on the client, and still render the API's `issues`. The scaffolded form does both, mapping issue paths to fields.
- **After a mutation,** `await router.invalidate()` before navigating, so loaders refetch.
- **Every data route declares** `pendingComponent`, `errorComponent`, and `notFoundComponent` where a record can be missing.
- **Accessibility:**
  - every input has a `<label htmlFor>`
  - errors are linked with `aria-describedby` and marked `aria-invalid`
  - form-level errors use `role="alert"`
  - actions are `<button>` and navigation is `<Link>`
  - destructive actions confirm inline, not with `window.confirm`
- **`routeTree.gen.ts` is generated.** Never edit it. New route files only become typed after a build or dev run regenerates it.

## 4. Verify

Build first, then typecheck and lint. They must not run in parallel: `typecheck` doesn't wait for the web build, so new routes type-check against a stale route tree and fail with errors like `'"/line-items/"' is not assignable to parameter of type '"/"'`.

```bash
pnpm turbo run build --force
pnpm turbo run typecheck lint --force
```

`pnpm install` needs Node `^22.22.3 || ^24.15.0 || >=26`. If it fails on the Node version, report it.

Then run the stack and use the UI (details in the `run-stack` skill):

1. **Start clean:** `node scripts/stack.mjs up --fresh` creates a throwaway Postgres, migrates, starts the API on 3457 and the web app on 3100 with `API_URL` wired up.
2. **Check the server-rendered HTML:**
   - `curl -s http://localhost:3100/<res>` has the `<h1>`, the `<title>` and the empty state, and returns 200 with no redirect.
   - A random uuid under `/<res>/…` returns a 404 not-found page.
3. **In the browser** (wait for hydration first; see `run-stack` for driving React inputs when clicks time out):
   - Submit an empty create form: field errors appear.
   - Create a record: it redirects to the detail page, and the title updates.
   - Edit: submit with no changes (form error), then change one field and clear a nullable one.
   - Delete (confirm step): it returns to the list and shows the empty state.
   - Seed more than `limit` records through the API to check Previous/Next.
   - Reload a page directly and read the console: no hydration warnings or errors.
4. **Run the e2e suite** if it covers these pages: `PLAYWRIGHT_CHANNEL=chrome pnpm --filter @aure/e2e test:web` (reuses the running stack).
5. **Stop:** `node scripts/stack.mjs down`.

## 5. Report

Tell the caller:
- the routes added (paths, search params) and the main components
- the `packages/api-client` methods added
- the verification run, including the browser checks and anything not exercised
- **handoff for the backend:** contract or endpoint changes the UI needs
- open decisions: styling, auth/session, how foreign-key fields should be picked
