# apps/api standards (NestJS 12, CommonJS)

## File structure

```
apps/api/src/
  main.ts                    bootstrap only: global prefix /api, PORT
  app.module.ts              imports feature modules + DbModule
  app.controller.ts          GET /api/health
  common/                    cross-feature Nest pieces: zod-validation.pipe.ts, pg-errors.ts
  db/db.module.ts            the only place a pg Pool is created (PG_POOL token)
  <resources>/               one folder per resource, plural kebab-case
    <resources>.module.ts
    <resources>.controller.ts
    <resources>.service.ts
    <resources>.repository.ts
    <resources>.mapper.ts
```

- No other file roles in a feature folder. A helper used by one feature belongs in that feature's service or mapper. A helper used by several goes in `common/`.
- Class names: `<Resources>Module`, `<Resources>Controller`, `<Resources>Service`, `<Resources>Repository` (plural). Mapper functions: `to<Entity>`, `to<Entity>Insert`, `to<Entity>Update` (singular).
- Repository method vocabulary: `list`, `findById`, `findBy<Field>`, `insert`, `update`, `remove`, `exists…`. Service method vocabulary: `list`, `get`, `create`, `update`, `remove`, plus domain verbs (`cancel`, `approve`).

## Layers: who may do what

| Layer | Allowed | Not allowed |
|---|---|---|
| Controller | route decorators, `ZodValidationPipe` with contract schemas, call one service method, `@HttpCode` | business logic, repository or db access, try/catch that changes meaning |
| Service | business rules, contract types in and out, throw Nest `HttpException`s, translate pg constraint errors | SQL, `@aure/db` or `pg` imports, knowledge of HTTP request objects |
| Repository | parameterized SQL through the injected `Pool`, rows in and out, transactions | contract types, HTTP exceptions, business rules |
| Mapper | pure row↔contract conversion (`Date` ↔ ISO string, snake_case ↔ camelCase) | I/O, side effects |

ESLint enforces the database boundary (`@aure/db`/`pg` only in `*.repository.ts`, `*.mapper.ts`, `db.module.ts`). Review the rest by reading.

## HTTP conventions

- **Routes** are plural kebab-case nouns: `GET /api/line-items`, `GET /api/line-items/:id`. Non-CRUD actions are sub-resources or verbs on an item: `POST /api/orders/:id/cancel`. No verbs in collection paths (`/api/getOrders`).
- **Status codes:** `POST` create → 201 with the resource; `DELETE` → 204 with no body; invalid input → 400 `{ message, issues: [{ path, message }] }`; unknown id → 404; uniqueness or state conflict → 409; not allowed → 403. Never 200 with an error body, and never a 500 for a predictable failure.
- **Lists** return `{ items, limit, offset }` with `PageQuerySchema` (limit 1–100, default 50) and a deterministic order (`created_at DESC, id`).
- **Validation:** every body, query and param goes through `ZodValidationPipe` with a contract schema. No hand-rolled checks in controllers, no class-validator DTOs.
- **Responses** are contract types produced by the mapper. Never return a row or a pg result.

## Imports (isolatedModules + emitDecoratorMetadata)

- Classes injected by type (services, repositories) are **plain imports**. `import type` makes the DI metadata `Object`, and Nest fails at runtime with no compile error. Blocker.
- Non-class types in decorated signatures (zod-inferred contract types in `@Body()`/`@Query()`/`@Param()`, a `Pool` injected with `@Inject(PG_POOL)`) are **`type` imports**, or TS1272. Row types in repositories are `import type`.
- `verbatimModuleSyntax` is off here and `consistent-type-imports` is disabled on purpose. Don't "fix" either.

## Errors

- Expected failures throw Nest exceptions from the service (`NotFoundException`, `ConflictException`, `ForbiddenException`, `BadRequestException`).
- pg constraint errors are translated with `isPgError(error, PG_UNIQUE_VIOLATION | PG_FOREIGN_KEY_VIOLATION)` right where the write happens. Anything else is re-thrown **unwrapped**. Wrapping in `new Error(…, { cause })` hides the pg `code` and turns `HttpException`s into 500s.
- No empty `catch`, and no `catch` that logs and continues without a reason.

## SQL (raw node-postgres)

- Values are always `$n` parameters. Identifiers (columns, tables) come only from constants in the repository (`COLUMNS`, `UPDATABLE_COLUMNS`). Any other `${…}` in a SQL template is a blocker unless proven constant.
- Multi-statement writes use one client with `BEGIN`/`COMMIT`/`ROLLBACK` and `release()` in `finally`.
- `INSERT … RETURNING` / `UPDATE … RETURNING` for the written row. No read-after-write round trip.
- Watch for N+1 queries in loops. Batch with `WHERE id = ANY($1)` or a join.

## Security review points

- Every mutating endpoint: who is allowed? If there's no auth model yet, flag it as an open decision rather than silently approving.
- Client-writable fields: server-owned fields (status, owner, totals) must not be in `Create…Schema`/`Update…Schema`.
- No secrets or connection strings in code or logs.
