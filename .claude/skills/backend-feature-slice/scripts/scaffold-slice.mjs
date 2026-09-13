#!/usr/bin/env node
// Scaffold one API feature slice (CRUD resource) for apps/api and its data inputs:
//
//   packages/contracts/src/<plural>.ts        zod schemas + types
//   packages/db/src/rows/<plural>.ts          row / insert / update types
//   packages/db/migrations/<ts>_create_<table>.sql
//   apps/api/src/<plural>/<plural>.{repository,mapper,service,controller,module}.ts
//
// and registers the slice in app.module.ts and the package index files.
// First run also bootstraps packages/{contracts,db} and the shared api pieces
// (DbModule, ZodValidationPipe, pg-errors) if they don't exist yet.
//
// It deliberately does NOT touch packages/api-client or apps/web: those belong to
// the web side. The report lists the endpoints and contract schemas they need.
//
// Never overwrites an existing file. Re-running is safe.
//
// usage:
//   node scaffold-slice.mjs <plural> --singular <name> --fields "<name>:<type>[?],..." [--dry-run]
//   types: string | int | number | boolean | date | uuid   (? = nullable/optional)
//   e.g. node scaffold-slice.mjs line-items --singular line-item \
//          --fields "sku:string,quantity:int,note:string?,shippedAt:date?"

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const dryRun = argv.includes("--dry-run");
const plural = argv[0];
const singular = flag("singular");
const fieldSpec = flag("fields");

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
if (!plural || plural.startsWith("--") || !singular || !fieldSpec) {
  fail('usage: scaffold-slice.mjs <plural> --singular <name> --fields "title:string,notes:string?" [--dry-run]');
}
if (!KEBAB.test(plural) || !KEBAB.test(singular)) fail("resource names must be kebab-case, e.g. line-items / line-item");

const TYPES = {
  string: { zod: "z.string()", ts: "string", sql: "text" },
  int: { zod: "z.number().int()", ts: "number", sql: "integer" },
  number: { zod: "z.number()", ts: "number", sql: "double precision" },
  boolean: { zod: "z.boolean()", ts: "boolean", sql: "boolean" },
  date: { zod: "z.iso.datetime()", ts: "Date", sql: "timestamptz" },
  uuid: { zod: "z.uuid()", ts: "string", sql: "uuid" },
};
const RESERVED = new Set(["id", "createdAt", "updatedAt"]);

const fields = fieldSpec.split(",").map((raw) => {
  const m = /^\s*([a-z][A-Za-z0-9]*)\s*:\s*([a-z]+)(\?)?\s*$/.exec(raw);
  if (!m) fail(`bad field "${raw}". Use camelCaseName:type or camelCaseName:type?`);
  const [, name, type, optional] = m;
  if (!TYPES[type]) fail(`unknown type "${type}" for ${name}. Use: ${Object.keys(TYPES).join(", ")}`);
  if (RESERVED.has(name)) fail(`"${name}" is generated automatically; don't list it`);
  return { name, column: snake(name), type, nullable: Boolean(optional), ...TYPES[type] };
});

// --------------------------------------------------------------- names ----
const pascal = (s) => s.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join("");
const camel = (s) => pascal(s)[0].toLowerCase() + pascal(s).slice(1);
function snake(s) {
  return s.replace(/-/g, "_").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

const N = {
  plural, // line-items  (file + route names)
  table: snake(plural), // line_items
  Entity: pascal(singular), // LineItem
  Entities: pascal(plural), // LineItems
  entities: camel(plural), // lineItems
};

// ---------------------------------------------------------------- fs ------
const root = findRoot(process.cwd());
if (!root) fail("run this from inside the aure repo (no pnpm-workspace.yaml found)");
const created = [];
const skipped = [];
const edited = [];
const notes = [];

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, "pnpm-workspace.yaml"))) return d;
    if (path.dirname(d) === d) return null;
  }
}
function fail(msg) {
  process.stderr.write(`scaffold-slice: ${msg}\n`);
  process.exit(1);
}
function write(rel, content) {
  const file = path.join(root, rel);
  if (existsSync(file)) return void skipped.push(rel);
  if (!dryRun) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content.replace(/^\n/, ""));
  }
  created.push(rel);
}
function edit(rel, fn) {
  const file = path.join(root, rel);
  if (!existsSync(file)) {
    if (!(dryRun && created.includes(rel))) notes.push(`missing ${rel}; edit by hand`);
    return;
  }
  const before = readFileSync(file, "utf8");
  const after = fn(before);
  if (after === null) return void notes.push(`could not update ${rel} automatically; edit by hand`);
  if (after === before) return;
  if (!dryRun) writeFileSync(file, after);
  if (!created.includes(rel) && !edited.includes(rel)) edited.push(rel);
}
const json = (o) => JSON.stringify(o, null, 2) + "\n";

// ------------------------------------------------------ package bootstrap --
const dualExports = {
  ".": {
    import: { types: "./dist/index.d.ts", default: "./dist/index.js" },
    require: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
  },
};
// tsup's dts build sets baseUrl internally, which TypeScript 6 rejects as deprecated.
const tsup = {
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  sourcemap: true,
};
const devDeps = {
  "@aure/config-eslint": "workspace:*",
  "@aure/config-ts": "workspace:*",
  eslint: "catalog:",
  tsup: "catalog:",
  typescript: "catalog:",
};
const eslintConfig = `export { default } from "@aure/config-eslint/base";\n`;

function bootstrapPackage(name, { deps = {}, extraDev = {}, scripts = {}, tsconfig, index, extra = {} }) {
  const dir = `packages/${name}`;
  if (existsSync(path.join(root, dir, "package.json"))) return;
  write(`${dir}/package.json`, json({
    name: `@aure/${name}`,
    version: "0.0.0",
    private: true,
    type: "module",
    exports: dualExports,
    scripts: { build: "tsup", typecheck: "tsc --noEmit", lint: "eslint .", ...scripts },
    tsup,
    dependencies: deps,
    devDependencies: { ...devDeps, ...extraDev },
  }));
  write(`${dir}/tsconfig.json`, json({
    extends: "@aure/config-ts/library.json",
    ...(tsconfig ? { compilerOptions: tsconfig } : {}),
    include: ["src"],
  }));
  write(`${dir}/eslint.config.mjs`, eslintConfig);
  write(`${dir}/src/index.ts`, index);
  for (const [rel, content] of Object.entries(extra)) write(`${dir}/${rel}`, content);
}

bootstrapPackage("contracts", {
  deps: { zod: "catalog:" },
  index: `
export * from "./common";
`,
  extra: {
    "src/common.ts": `
import { z } from "zod";

/** Route param for resource ids. */
export const IdParamSchema = z.uuid();

/** limit/offset pagination, parsed from the query string. */
export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;
`,
  },
});

bootstrapPackage("db", {
  deps: { pg: "catalog:" },
  extraDev: { "@types/node": "catalog:", "@types/pg": "catalog:" },
  scripts: { migrate: "node migrate.mjs" },
  tsconfig: { types: ["node"] },
  index: `
import pg from "pg";

export type { Pool, PoolClient, QueryResultRow } from "pg";

/** Lazily-connecting pool. Nothing talks to Postgres until the first query. */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}
`,
  extra: {
    "migrations/.gitkeep": "",
    "migrate.mjs": `
// Applies packages/db/migrations/*.sql in filename order, once each, each in
// its own transaction. Usage: DATABASE_URL=postgres://... pnpm --filter @aure/db migrate
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is not set\\n");
  process.exit(1);
}

const dir = new URL("./migrations/", import.meta.url);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const { rows } = await client.query("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(new URL(file, dir), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      process.stdout.write(\`applied \${file}\\n\`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.end();
}
`,
  },
});

// ---------------------------------------------- shared api infrastructure --
write("apps/api/src/db/db.module.ts", `
import { Global, Inject, Module, OnApplicationShutdown } from "@nestjs/common";
// Pool is a type (injected by token), so it must be a type import: with
// isolatedModules + emitDecoratorMetadata, TS rejects plain imports of types used
// in decorated signatures. Classes Nest injects by type still need plain imports.
import { createPool, type Pool } from "@aure/db";

export const PG_POOL = Symbol("PG_POOL");

/**
 * The only place apps/api creates a Postgres pool. Repositories inject it with
 * @Inject(PG_POOL). The pool connects lazily, so the app boots without a
 * reachable database, but DATABASE_URL must be set.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error("DATABASE_URL is not set");
        return createPool(url);
      },
    },
  ],
  exports: [PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
`);

write("apps/api/src/common/zod-validation.pipe.ts", `
import { BadRequestException, PipeTransform } from "@nestjs/common";
import { z } from "zod";

/**
 * Validates and parses a request value against a contract schema. Use per
 * parameter: @Body(new ZodValidationPipe(CreateThingSchema)) body: CreateThingInput
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: "Validation failed",
        issues: result.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
`);

write("apps/api/src/common/pg-errors.ts", `
/** Postgres SQLSTATE codes worth translating into HTTP errors. */
export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";

export function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
`);

// -------------------------------------------------------------- the slice --
const { plural: p, table, Entity, Entities, entities } = N;
const f = fields;
const cols = ["id", ...f.map((x) => x.column), "created_at", "updated_at"].join(", ");

// contracts
write(`packages/contracts/src/${p}.ts`, `
import { z } from "zod";

export const ${Entity}Schema = z.object({
  id: z.uuid(),
${f.map((x) => `  ${x.name}: ${x.zod}${x.nullable ? ".nullable()" : ""},`).join("\n")}
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ${Entity} = z.infer<typeof ${Entity}Schema>;

export const Create${Entity}Schema = z.object({
${f.map((x) => `  ${x.name}: ${x.zod}${x.nullable ? ".nullable().optional()" : ""},`).join("\n")}
});
export type Create${Entity}Input = z.infer<typeof Create${Entity}Schema>;

export const Update${Entity}Schema = Create${Entity}Schema.partial().refine(
  (input) => Object.values(input).some((value) => value !== undefined),
  { message: "Provide at least one field to update" },
);
export type Update${Entity}Input = z.infer<typeof Update${Entity}Schema>;

export const ${Entity}ListSchema = z.object({
  items: z.array(${Entity}Schema),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type ${Entity}List = z.infer<typeof ${Entity}ListSchema>;
`);
edit("packages/contracts/src/index.ts", (s) =>
  s.includes(`"./${p}"`) ? s : `${s.trimEnd()}\nexport * from "./${p}";\n`,
);

// db rows + migration
const rowType = (x) => `${x.ts}${x.nullable ? " | null" : ""}`;
write(`packages/db/src/rows/${p}.ts`, `
/** Row shape of the ${table} table as node-postgres returns it. */
export interface ${Entity}Row {
  id: string;
${f.map((x) => `  ${x.column}: ${rowType(x)};`).join("\n")}
  created_at: Date;
  updated_at: Date;
}

/** Columns written on insert. id and timestamps come from column defaults. */
export interface ${Entity}Insert {
${f.map((x) => `  ${x.column}: ${rowType(x)};`).join("\n")}
}

export type ${Entity}Update = Partial<${Entity}Insert>;
`);
edit("packages/db/src/index.ts", (s) =>
  s.includes(`"./rows/${p}"`) ? s : `${s.trimEnd()}\n\nexport * from "./rows/${p}";\n`,
);
const migrationsDir = path.join(root, "packages/db/migrations");
const alreadyMigrated =
  existsSync(migrationsDir) && readdirSync(migrationsDir).some((n) => n.endsWith(`_create_${table}.sql`));
if (!alreadyMigrated) {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  write(`packages/db/migrations/${stamp}_create_${table}.sql`, `
CREATE TABLE ${table} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
${f.map((x) => `  ${x.column} ${x.sql}${x.nullable ? "" : " NOT NULL"},`).join("\n")}
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ${table}_created_at_idx ON ${table} (created_at DESC, id);
`);
} else {
  skipped.push(`packages/db/migrations/*_create_${table}.sql`);
}

// api: repository
write(`apps/api/src/${p}/${p}.repository.ts`, `
import { Inject, Injectable } from "@nestjs/common";
import type { ${Entity}Insert, ${Entity}Row, ${Entity}Update, Pool } from "@aure/db";

import { PG_POOL } from "../db/db.module";

const COLUMNS = "${cols}";
const UPDATABLE_COLUMNS = [${f.map((x) => `"${x.column}"`).join(", ")}] as const;

/** SQL for the ${table} table. Speaks rows only; the mapper converts to contracts. */
@Injectable()
export class ${Entities}Repository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list(limit: number, offset: number): Promise<${Entity}Row[]> {
    const { rows } = await this.pool.query<${Entity}Row>(
      \`SELECT \${COLUMNS} FROM ${table} ORDER BY created_at DESC, id LIMIT $1 OFFSET $2\`,
      [limit, offset],
    );
    return rows;
  }

  async findById(id: string): Promise<${Entity}Row | undefined> {
    const { rows } = await this.pool.query<${Entity}Row>(\`SELECT \${COLUMNS} FROM ${table} WHERE id = $1\`, [id]);
    return rows[0];
  }

  async insert(values: ${Entity}Insert): Promise<${Entity}Row> {
    const { rows } = await this.pool.query<${Entity}Row>(
      \`INSERT INTO ${table} (${f.map((x) => x.column).join(", ")}) VALUES (${f.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING \${COLUMNS}\`,
      [${f.map((x) => `values.${x.column}`).join(", ")}],
    );
    const row = rows[0];
    if (!row) throw new Error("INSERT into ${table} returned no row");
    return row;
  }

  async update(id: string, patch: ${Entity}Update): Promise<${Entity}Row | undefined> {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const column of UPDATABLE_COLUMNS) {
      const value = patch[column];
      if (value !== undefined) {
        values.push(value);
        sets.push(\`\${column} = $\${values.length}\`);
      }
    }
    if (sets.length === 0) return this.findById(id);
    values.push(id);
    const { rows } = await this.pool.query<${Entity}Row>(
      \`UPDATE ${table} SET \${sets.join(", ")}, updated_at = now() WHERE id = $\${values.length} RETURNING \${COLUMNS}\`,
      values,
    );
    return rows[0];
  }

  async remove(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(\`DELETE FROM ${table} WHERE id = $1\`, [id]);
    return (rowCount ?? 0) > 0;
  }
}
`);

// api: mapper
const toContract = (x) =>
  x.type === "date"
    ? x.nullable
      ? `row.${x.column} === null ? null : row.${x.column}.toISOString()`
      : `row.${x.column}.toISOString()`
    : `row.${x.column}`;
const toInsert = (x) =>
  x.type === "date"
    ? x.nullable
      ? `input.${x.name} == null ? null : new Date(input.${x.name})`
      : `new Date(input.${x.name})`
    : x.nullable
      ? `input.${x.name} ?? null`
      : `input.${x.name}`;
const toUpdate = (x) =>
  x.type === "date"
    ? x.nullable
      ? `input.${x.name} === null ? null : new Date(input.${x.name})`
      : `new Date(input.${x.name})`
    : `input.${x.name}`;

write(`apps/api/src/${p}/${p}.mapper.ts`, `
import { Create${Entity}Input, ${Entity}, Update${Entity}Input } from "@aure/contracts";
import { ${Entity}Insert, ${Entity}Row, ${Entity}Update } from "@aure/db";

/** The only place ${table} rows and ${Entity} contracts meet. */
export function to${Entity}(row: ${Entity}Row): ${Entity} {
  return {
    id: row.id,
${f.map((x) => `    ${x.name}: ${toContract(x)},`).join("\n")}
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function to${Entity}Insert(input: Create${Entity}Input): ${Entity}Insert {
  return {
${f.map((x) => `    ${x.column}: ${toInsert(x)},`).join("\n")}
  };
}

export function to${Entity}Update(input: Update${Entity}Input): ${Entity}Update {
  const patch: ${Entity}Update = {};
${f.map((x) => `  if (input.${x.name} !== undefined) patch.${x.column} = ${toUpdate(x)};`).join("\n")}
  return patch;
}
`);

// api: service
write(`apps/api/src/${p}/${p}.service.ts`, `
import { Injectable, NotFoundException } from "@nestjs/common";
import { Create${Entity}Input, ${Entity}, ${Entity}List, PageQuery, Update${Entity}Input } from "@aure/contracts";

import { to${Entity}, to${Entity}Insert, to${Entity}Update } from "./${p}.mapper";
import { ${Entities}Repository } from "./${p}.repository";

/** Business rules for ${plural}. Works in contract types only. */
@Injectable()
export class ${Entities}Service {
  constructor(private readonly repository: ${Entities}Repository) {}

  async list(page: PageQuery): Promise<${Entity}List> {
    const rows = await this.repository.list(page.limit, page.offset);
    return { items: rows.map(to${Entity}), limit: page.limit, offset: page.offset };
  }

  async get(id: string): Promise<${Entity}> {
    const row = await this.repository.findById(id);
    if (!row) throw new NotFoundException(\`${Entity} \${id} not found\`);
    return to${Entity}(row);
  }

  async create(input: Create${Entity}Input): Promise<${Entity}> {
    return to${Entity}(await this.repository.insert(to${Entity}Insert(input)));
  }

  async update(id: string, input: Update${Entity}Input): Promise<${Entity}> {
    const row = await this.repository.update(id, to${Entity}Update(input));
    if (!row) throw new NotFoundException(\`${Entity} \${id} not found\`);
    return to${Entity}(row);
  }

  async remove(id: string): Promise<void> {
    if (!(await this.repository.remove(id))) throw new NotFoundException(\`${Entity} \${id} not found\`);
  }
}
`);

// api: controller + module
write(`apps/api/src/${p}/${p}.controller.ts`, `
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import {
  type Create${Entity}Input,
  Create${Entity}Schema,
  type ${Entity},
  type ${Entity}List,
  IdParamSchema,
  type PageQuery,
  PageQuerySchema,
  type Update${Entity}Input,
  Update${Entity}Schema,
} from "@aure/contracts";

import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ${Entities}Service } from "./${p}.service";

@Controller("${p}")
export class ${Entities}Controller {
  constructor(private readonly service: ${Entities}Service) {}

  @Get()
  list(@Query(new ZodValidationPipe(PageQuerySchema)) page: PageQuery): Promise<${Entity}List> {
    return this.service.list(page);
  }

  @Get(":id")
  get(@Param("id", new ZodValidationPipe(IdParamSchema)) id: string): Promise<${Entity}> {
    return this.service.get(id);
  }

  @Post()
  create(@Body(new ZodValidationPipe(Create${Entity}Schema)) body: Create${Entity}Input): Promise<${Entity}> {
    return this.service.create(body);
  }

  @Patch(":id")
  update(
    @Param("id", new ZodValidationPipe(IdParamSchema)) id: string,
    @Body(new ZodValidationPipe(Update${Entity}Schema)) body: Update${Entity}Input,
  ): Promise<${Entity}> {
    return this.service.update(id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id", new ZodValidationPipe(IdParamSchema)) id: string): Promise<void> {
    return this.service.remove(id);
  }
}
`);

write(`apps/api/src/${p}/${p}.module.ts`, `
import { Module } from "@nestjs/common";

import { ${Entities}Controller } from "./${p}.controller";
import { ${Entities}Repository } from "./${p}.repository";
import { ${Entities}Service } from "./${p}.service";

@Module({
  controllers: [${Entities}Controller],
  providers: [${Entities}Service, ${Entities}Repository],
})
export class ${Entities}Module {}
`);

// api: register modules in AppModule
function registerModule(src, className, importPath) {
  let out = src;
  if (!out.includes(`import { ${className} }`)) {
    const imports = [...out.matchAll(/^import .*;$/gm)];
    const last = imports.at(-1);
    if (!last) return null;
    const at = last.index + last[0].length;
    out = `${out.slice(0, at)}\nimport { ${className} } from "${importPath}";${out.slice(at)}`;
  }
  const decorator = /@Module\(\{/.exec(out);
  if (!decorator) return null;
  const arr = /imports:\s*\[([^\]]*)\]/.exec(out);
  if (arr) {
    if (new RegExp(`\\b${className}\\b`).test(arr[1])) return out;
    const items = arr[1].trim() ? `${arr[1].trim().replace(/,$/, "")}, ${className}` : className;
    return out.replace(arr[0], `imports: [${items}]`);
  }
  const at = decorator.index + decorator[0].length;
  return `${out.slice(0, at)}\n  imports: [${className}],${out.slice(at)}`;
}
edit("apps/api/src/app.module.ts", (s) => registerModule(s, "DbModule", "./db/db.module"));
edit("apps/api/src/app.module.ts", (s) => registerModule(s, `${Entities}Module`, `./${p}/${p}.module`));

// package.json dependencies for apps/api
edit("apps/api/package.json", (s) => {
  const pkg = JSON.parse(s);
  pkg.dependencies ??= {};
  const want = { "@aure/contracts": "workspace:*", "@aure/db": "workspace:*", zod: "catalog:" };
  let changed = false;
  for (const [k, v] of Object.entries(want)) {
    if (!pkg.dependencies[k]) {
      pkg.dependencies[k] = v;
      changed = true;
    }
  }
  if (!changed) return s;
  pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));
  return json(pkg);
});

// DATABASE_URL is runtime-only: pass it through without making it a cache key.
edit("turbo.json", (s) => {
  const turbo = JSON.parse(s);
  const list = (turbo.globalPassThroughEnv ??= []);
  if (list.includes("DATABASE_URL")) return s;
  list.push("DATABASE_URL");
  return json(turbo);
});

// catalog check: versions are chosen by the upgrade-dependency workflow, not here
const workspaceYaml = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
const missingCatalog = ["zod", "tsup", "pg", "@types/pg"].filter(
  (name) => !new RegExp(`^\\s+"?${name.replace("/", "\\/")}"?:`, "m").test(workspaceYaml),
);
if (missingCatalog.length) {
  notes.push(
    `pnpm-workspace.yaml catalog is missing: ${missingCatalog.join(", ")}. ` +
      "Add the newest mature versions (upgrade-dependency skill's mature-versions.mjs) before pnpm install.",
  );
}

// ------------------------------------------------------------- report ----
const out = [];
out.push(`${dryRun ? "[dry run] " : ""}slice "${p}" (${Entity}), table ${table}`);
if (created.length) out.push(`created:\n${created.map((x) => `  + ${x}`).join("\n")}`);
if (edited.length) out.push(`edited:\n${edited.map((x) => `  ~ ${x}`).join("\n")}`);
if (skipped.length) out.push(`skipped (already exist):\n${skipped.map((x) => `  = ${x}`).join("\n")}`);
if (notes.length) out.push(`ACTION NEEDED:\n${notes.map((x) => `  ! ${x}`).join("\n")}`);
out.push(`endpoints: GET/POST /api/${p}, GET/PATCH/DELETE /api/${p}/:id`);
out.push(
  `handoff (not generated): packages/api-client needs list/get/create/update/remove for /api/${p}, ` +
    `validated with ${Entity}Schema / ${Entity}ListSchema; inputs Create${Entity}Input / Update${Entity}Input / PageQuery.`,
);
process.stdout.write(out.join("\n") + "\n");
