# packages/contracts, packages/db, packages/api-client standards

All three are libraries built with tsup to dual ESM + CJS (`apps/api` is CommonJS, and web and e2e are ESM). See workspace.md for package setup.

## packages/contracts (zod 4)

```
src/index.ts          export * from "./<resources>"   (one line per resource)
src/common.ts         IdParamSchema, PageQuerySchema, PageQuery
src/<resources>.ts    one file per resource
```

Per resource, in this order:

```ts
export const OrderSchema = z.object({ id: z.uuid(), …, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export type Order = z.infer<typeof OrderSchema>;
export const CreateOrderSchema = z.object({ … });           export type CreateOrderInput = z.infer<…>;
export const UpdateOrderSchema = CreateOrderSchema.partial().refine(…at least one field…); export type UpdateOrderInput = …;
export const OrderListSchema = z.object({ items: z.array(OrderSchema), limit, offset }); export type OrderList = …;
```

- **Names:** `<Entity>Schema`/`<Entity>`, `Create<Entity>Schema`/`Create<Entity>Input`, `Update<Entity>Schema`/`Update<Entity>Input`, `<Entity>ListSchema`/`<Entity>List`. Every exported schema ends in `Schema`, and its type has the same name without the suffix.
- **Shape:** fields are camelCase. Dates are ISO strings (`z.iso.datetime()`), never `Date`. Money is an integer in minor units (`priceCents`). Nullable means `.nullable()` on read and `.nullable().optional()` on create.
- **zod 4 API:** `z.uuid()`, `z.email()`, `z.url()`, `z.iso.datetime()`, `z.flattenError()`. The `z.string().uuid()` chains and `error.flatten()` are deprecated.
- **Validation matches the database:** `NOT NULL` → required; `CHECK` → `.min`/`.max`/`.positive`/`z.enum`. Otherwise bad input becomes a 500 instead of a 400.
- **Server-owned fields** are absent from `Create…`/`Update…` schemas.
- **Compatibility:** contracts are shared by API and web. Additive changes (new optional field, new schema) are fine. Renaming, removing or retyping a field is a **breaking change**: it needs an explicit handoff in the PR description, or it's a major finding.
- Contracts contain schemas and types only: no functions with side effects, no imports from other `@aure/*` packages.

## packages/db (raw pg)

```
src/index.ts                 createPool, type re-exports, export * from "./rows/<resources>"
src/rows/<resources>.ts      <Entity>Row, <Entity>Insert, <Entity>Update
migrations/<YYYYMMDDHHMMSS>_<verb>_<object>.sql
migrate.mjs                  applies migrations in order, once each, each in a transaction
```

- **Row types mirror columns exactly:** snake_case, `Date` for `timestamptz`, `string` for `uuid`, `T | null` for nullable columns. `<Entity>Insert` lists written columns (no id or timestamps). `<Entity>Update = Partial<<Entity>Insert>`.
- **Migrations:**
  - The file name is a UTC timestamp + `verb_object` (`20260913094814_create_orders.sql`, `…_add_status_to_orders.sql`).
  - **Never edit a migration that may have been applied anywhere** (blocker); add a new one.
  - One logical change per file, and each must run inside a transaction (no `CREATE INDEX CONCURRENTLY` without a note explaining why).
- **Tables:** plural snake_case. `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`.
- **Constraints:** foreign keys declare `ON DELETE` behavior explicitly and get an index. Enums are `text` + `CHECK (col IN (…))`. `UNIQUE` and `CHECK` constraints enforce invariants in the database, not just in zod.
- **Types to avoid:** `bigint` returns strings from `pg`, and floating types for money lose cents. Flag both unless justified.
- The db package has no ORM or query builder, by decision. Adding one is a blocker without an explicit decision.

## packages/api-client

```
src/index.ts          createApiClient: one line per resource between // scaffold:imports and // scaffold:resources markers
src/http.ts           createHttp, ApiError, toQuery
src/<resources>.ts    <resources>Client(http) → { list, get, create, update, remove, …domain verbs }
```

- **Every JSON response is parsed with its contract schema** (`http.json(method, path, Schema, body)`). Unvalidated `response.json()` is a major finding.
- Path params use `encodeURIComponent`, and query strings go through `toQuery`.
- Method names follow the service vocabulary (`list`, `get`, `create`, `update`, `remove`, domain verbs). Paths match the API's routes exactly.
- The client is transport only: no caching, retries or business logic. It's used by `apps/web/src/server/**` only (see web.md).
