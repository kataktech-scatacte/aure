---
name: backend-feature-slice
description: Build an API feature in apps/api (NestJS) end to end. Covers the zod contract in packages/contracts and the row types plus SQL migration in packages/db (raw node-postgres) that the API needs, then the repository, mapper, service, controller and module in apps/api, verified against a real Postgres. Includes a scaffold script that generates a working CRUD slice and bootstraps contracts/db on first use. It does not build the web client (packages/api-client, apps/web); it hands those off in the report. Use this for any new API resource, endpoint, table, or data-backed API feature ("add orders", "we need a customers endpoint", "store invoices"), and when extending an existing API resource with fields, queries, or non-CRUD endpoints.
---

# API feature slice

A feature in `apps/api` is a vertical slice. Its layers only talk to their neighbors, and ESLint enforces the database boundary:

```
packages/contracts   zod schemas + types     (the API's public shape; web reads it too)
packages/db          row types, migrations    (raw pg; only repositories/mappers import it)
apps/api/src/<res>/  repository -> mapper -> service -> controller -> module
```

This separation is why the rules exist:
- **Contracts** are the public API: they change deliberately.
- **Rows** mirror the database: they change with migrations.
- **The mapper** is the single place the two meet, so a column rename never leaks into responses.
- **The service** holds business rules and never sees SQL.
- **The controller** only validates input and delegates to the service.

**Scope:**
- `apps/api` is the work.
- `packages/contracts` and `packages/db` are touched only for what the API change needs.
- `packages/api-client` and `apps/web` are out of scope. Never edit them; list what they need in the report.

## 1. Design the resource first

Before generating anything, decide:
- **Names.** kebab-case plural and singular, e.g. `line-items` / `line-item`. They become the route (`/api/line-items`), the table (`line_items`) and the classes (`LineItem`, `LineItemsService`).
- **Fields and types.** `string | int | number | boolean | date | uuid`. Append `?` for nullable. Nullable fields are optional on create and can be set to `null` on update.
- **Not listed.** `id` (uuid), `createdAt` and `updatedAt` are always generated.
- **Beyond the generator:** uniqueness, foreign keys, enums, min/max lengths, money, soft delete, and who is allowed to do what. You add these by hand in step 3.

Use `int` for money in minor units (`priceCents`), never `number`: floating point loses cents. Postgres `bigint` comes back from `pg` as a string, so the generator doesn't offer it. Add it by hand if you truly need it.

**Changing an existing resource:** contracts are shared with the web side, so prefer additive changes (new optional fields, new endpoints). If a breaking change is unavoidable (renaming or removing a field, changing a type), stop and report it before making it. It breaks `packages/api-client` and `apps/web`, which this skill doesn't edit.

## 2. Scaffold

Run from the repo root:

```bash
node .claude/skills/backend-feature-slice/scripts/scaffold-slice.mjs line-items --singular line-item \
  --fields "orderId:uuid,sku:string,quantity:int,unitPriceCents:int,shippedAt:date?"
```

Add `--dry-run` to preview. The script:
- never overwrites existing files, so re-running is safe
- prints what it created, edited and skipped
- prints **ACTION NEEDED** lines for anything it couldn't do
- prints a **handoff** line describing the client methods the web side will need

On first use it also bootstraps:
- `packages/contracts` and `packages/db` (with `migrate.mjs`), each built with tsup to dual ESM + CJS. `apps/api` is CommonJS; web consumers are ESM.
- `DbModule` (the pool, injected via the `PG_POOL` token), `ZodValidationPipe` and `pg-errors.ts` in `apps/api`
- the `DATABASE_URL` pass-through in `turbo.json`
- the new workspace dependencies in `apps/api/package.json`

**Catalog:** `pg` and `@types/pg` are already in the catalog. If the script reports a missing catalog entry anyway, add the newest mature version with the `upgrade-dependency` skill before installing.

What the generated slice gives you:
- `GET /api/<res>?limit&offset` → `{ items, limit, offset }`: newest first, limit 1–100 (default 50).
- `GET /api/<res>/:id` → the resource, or 404.
- `POST /api/<res>` → 201 with the resource.
- `PATCH /api/<res>/:id` → partial update. An empty body, or one containing only unknown fields, is rejected with 400. `updated_at` is bumped.
- `DELETE /api/<res>/:id` → 204, or 404.
- Invalid bodies, queries and ids → 400 `{ message: "Validation failed", issues: [{ path, message }] }`.

## 3. Make it real

The scaffold is a correct baseline, not the finished feature. Go through each layer.

**Migration** (`packages/db/migrations/<timestamp>_create_<table>.sql`). Edit it before it's ever applied; once applied anywhere, write a new migration instead.
- Foreign keys: `order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE`, plus an index on the FK column.
- `UNIQUE` constraints, `CHECK` constraints (`quantity > 0`), enums as `text` + `CHECK (status IN (...))`.
- Indexes for the queries you'll actually run.

**Contract** (`packages/contracts/src/<res>.ts`):
- Tighten validation to match the table: `z.string().trim().min(1).max(200)`, `z.number().int().positive()`, `z.enum([...])`.
- Keep the create/update schemas in sync with the migration's NOT NULL and CHECK rules, so bad input gets a 400 instead of a database error turning into a 500.
- If a field must not be client-writable (status set by the server, owner id), remove it from `Create…Schema` and set it in the service.

**Repository** (SQL only, returns rows):
- Always use parameters (`$1`); never interpolate values into SQL.
- Column names in SQL come only from constants in the file (`COLUMNS`, `UPDATABLE_COLUMNS`), never from input.
- Add queries as methods: filters, `findByOrderId`, existence checks.
- For multi-statement writes, use a transaction on one client:

  ```ts
  const client = await this.pool.connect();
  try {
    await client.query("BEGIN");
    // ... client.query(...)
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  ```

**Mapper:** when you add columns, update all three functions (`to…`, `to…Insert`, `to…Update`). Dates travel as ISO strings in contracts and as `Date` in rows.

**Service** (business rules, contract types only):
- Throw Nest HTTP exceptions (`NotFoundException`, `ConflictException`, `ForbiddenException`, `BadRequestException`) so the API returns proper status codes.
- Translate constraint violations instead of letting them 500:

  ```ts
  try {
    return toLineItem(await this.repository.insert(toLineItemInsert(input)));
  } catch (error) {
    if (isPgError(error, PG_UNIQUE_VIOLATION)) throw new ConflictException("SKU already exists on this order");
    if (isPgError(error, PG_FOREIGN_KEY_VIOLATION)) throw new NotFoundException("Order not found");
    throw error;
  }
  ```

**Controller:** keep it thin. Add endpoints by composing `ZodValidationPipe` with contract schemas. For non-CRUD actions, prefer a sub-resource or verb route that reads naturally: `POST /api/orders/:id/cancel`, `GET /api/orders/:id/line-items`.

**Removing endpoints:** if the resource shouldn't support an endpoint (e.g. no DELETE for audit data), remove it from the controller, service and repository together. Mention the removal in the handoff so the client doesn't expose it.

### Import rules in apps/api

`apps/api` compiles with `isolatedModules` + `emitDecoratorMetadata`, which leads to two rules:
- **Classes Nest injects by type** (services, repositories): use a plain `import { OrdersService } from ...`. With `import type`, the metadata becomes `Object`, and DI fails at runtime with no compile error.
- **Types that appear in decorated signatures but aren't classes** (zod-inferred contract types in `@Body()`/`@Query()` params, the `Pool` injected via `@Inject(PG_POOL)`): use a type import (`import { type CreateOrderInput, CreateOrderSchema }`). Otherwise TypeScript fails with TS1272.

Packages under `packages/` use `verbatimModuleSyntax`, so every type-only import there needs `type`.

## 4. Verify

Run from the repo root. `pnpm install` needs Node `^22.22.3 || ^24.15.0 || >=26`, because `engineStrict` is on; if it fails with `ERR_PNPM_UNSUPPORTED_ENGINE`, report the Node version rather than working around it.

```bash
pnpm install
pnpm turbo run build typecheck lint --force
```

- Run the whole repo, so anything that consumes `packages/contracts` gets typechecked too.
- Use `--force` so a Turbo cache hit can't pass a broken slice.
- If a consumer outside your scope breaks (`packages/api-client`, `apps/web`), don't fix it there. Report exactly what broke and why. Normally this only happens after a breaking contract change you were meant to flag first.

Then prove it at runtime with the `run-stack` skill. `scripts/stack.mjs` creates a throwaway Postgres, runs your migrations, and starts the built API:

```bash
node scripts/stack.mjs up --fresh --no-web      # add web if the change affects pages
```

- **Migrations:** it applies them on `up`. Then run `DATABASE_URL=postgres://aure@localhost:55432/aure pnpm --filter @aure/db migrate` once more; the second run must apply nothing.
- **No Postgres on PATH:** `up --no-db` boots the API with a dummy `DATABASE_URL` (the pool is lazy). Verify only the validation paths (400s), and say clearly that database paths weren't exercised. Never guess credentials, and don't pull Docker images without asking.

Then curl every endpoint you shipped at `http://localhost:3457`:
- create → 201
- list and get → 200
- patch, including setting a nullable field to `null` → 200
- empty patch, wrong types and a bad uuid → 400
- delete → 204, then get → 404
- any conflict or foreign-key paths you added → 409 or 404

If `apps/e2e` has tests for this resource, run them too (`pnpm --filter @aure/e2e test:api`; they reuse your running stack). Finish with `node scripts/stack.mjs down`.

## 5. Report

Tell the caller:
- the endpoints, with method, path, request body, response shape and status codes
- the contract schemas and types added or changed in `packages/contracts`
- the migration file, and whether it has been applied anywhere
- the business rules and constraints you added beyond the scaffold
- the verification you ran and its results, including anything you could not exercise
- **handoff for the web side:** the client methods `packages/api-client` needs (from the scaffold's handoff line) and any breaking contract changes
- open items: env vars, and auth or ownership rules that are still undecided
