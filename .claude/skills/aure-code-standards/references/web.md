# apps/web standards (TanStack Start 1.168, React 19, Vite 8)

## File structure

```
apps/web/src/
  router.tsx                     createRouter + Register declaration
  routeTree.gen.ts               GENERATED: never edit; committed
  routes/
    __root.tsx                   document shell, global head (title, icon)
    index.tsx                    /
    <resources>/index.tsx        /<resources>          list
    <resources>/new.tsx          /<resources>/new      create
    <resources>/$id/index.tsx    /<resources>/$id      detail
    <resources>/$id/edit.tsx     /<resources>/$id/edit edit
  server/
    api.ts                       api() client factory, MutationResult, toResult
    <resources>.ts               server functions for one resource
  components/
    route-states.tsx             RoutePending, RouteError, RouteNotFound
    <resources>/<entity>-form.tsx
  lib/
    format.ts                    UTC date formatting helpers
```

- **Route files** export `Route` and define their page component in the same file, unexported, named `<Resources>ListPage`, `New<Entity>Page`, `<Entity>DetailPage`, `Edit<Entity>Page`.
- **Components shared by one resource** go in `components/<resources>/`; ones shared across resources go in `components/`. Pure helpers go in `lib/`. No `utils/` grab-bags.
- **Server functions** are named `list<Entities>`, `get<Entity>`, `create<Entity>`, `update<Entity>`, `delete<Entity>`, plus domain verbs.

## Boundaries (blockers)

- **Only `src/server/**` may import `@aure/api-client` or read `process.env`.** Route and component modules also run in the browser. The API has no CORS, and env vars there leak into the client bundle.
- **`createServerFn` only in `src/server/**`,** each with `.inputValidator(<contract schema>)` before `.handler`.
- **No `@aure/db` or `pg`** (lint enforces this). All data goes through the API.
- **Browser env:** only `import.meta.env.VITE_*` reaches the browser, and it's public. No secrets there.

## Routes and data

- **Loaders call server functions,** never the client directly. Loaders are isomorphic.
- **Search params:** validate with `validateSearch: <zod schema>`, keep defaults out of the URL with `search.middlewares: [stripSearchParams(…)]`, and declare `loaderDeps` for search-dependent loaders.
- **States:** every data route declares `pendingComponent` and `errorComponent`; routes for a single record also declare `notFoundComponent`. Server functions turn an API 404 into `throw notFound()`. Lists render an explicit empty state.
- **Titles:** set through `head()`, in the form `"<Page> · aure"`. No manual `<title>` or `<meta>`.
- **Navigation:** typed `Link`/`useNavigate` with `to` + `params`/`search`. No string-built URLs, and no casts to escape route typing.
- **After a mutation:** `await router.invalidate()`, then navigate.
- **Mutations** return `MutationResult` data (`toResult`) so forms can render API `issues`. Thrown errors are for the unexpected.

## Components

- **Function components** with an explicit `ReactNode` return type, and props typed inline or with an `interface`.
- **Hooks:** follow react-hooks lint. No effects to derive state; compute during render. No `useEffect` data fetching; that's what loaders are for.
- **Forms:**
  - validate with the contract schema client-side
  - render server `issues` next to fields
  - disable submit while in flight
  - use `noValidate` with custom messages
  - PATCH only changed fields
- **Accessibility** (major when missing):
  - every input has `<label htmlFor>`
  - errors are linked by `aria-describedby`, with `aria-invalid` set
  - form-level errors use `role="alert"`
  - actions are `<button type="button|submit">`, navigation is `Link`
  - pages have one `h1` and a sensible heading order
  - tables have `th scope`
  - destructive actions confirm inline (no `window.confirm`)
  - images have `alt`
- **Dates:** always format through `lib/format.ts` (fixed UTC). `toLocaleString`/`toLocaleDateString` in rendered output is a hydration-mismatch risk (major).
- **No new styling, UI or data-fetching libraries** (Tailwind, component kits, TanStack Query) without a recorded decision.

## Performance and correctness review points

- Loader waterfalls: independent server-function calls should run in parallel (`Promise.all`).
- Large lists paginate; don't fetch everything.
- Keys in lists are stable ids, never array indexes.
- No secrets, internal URLs or stack traces rendered to users (`RouteError` shows `error.message`, so make sure server errors don't carry sensitive text).
