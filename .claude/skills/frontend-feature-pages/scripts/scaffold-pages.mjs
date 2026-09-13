#!/usr/bin/env node
// Scaffold CRUD pages in apps/web for an API resource that already exists in
// packages/contracts (normally created by the backend-feature-slice scaffold).
//
//   packages/api-client/src/<plural>.ts          typed client methods (+ package bootstrap)
//   apps/web/src/server/<plural>.ts              server functions wrapping the client
//   apps/web/src/components/<plural>/<singular>-form.tsx
//   apps/web/src/routes/<plural>/index.tsx       list + pagination
//   apps/web/src/routes/<plural>/new.tsx         create form
//   apps/web/src/routes/<plural>/$id/index.tsx   detail + delete
//   apps/web/src/routes/<plural>/$id/edit.tsx    edit form
//
// Field names, types, nullability and enum options are read from the BUILT
// contract schemas (packages/contracts/dist), so hand-tightened contracts are
// respected. Build contracts first.
//
// Never overwrites existing files. Re-running is safe.
//
// usage: node scaffold-pages.mjs <plural> --singular <name> [--dry-run]
//   e.g. node scaffold-pages.mjs line-items --singular line-item

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const dryRun = argv.includes("--dry-run");
const plural = argv[0];
const singular = flag("singular");
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
if (!plural || plural.startsWith("--") || !singular) fail("usage: scaffold-pages.mjs <plural> --singular <name> [--dry-run]");
if (!KEBAB.test(plural) || !KEBAB.test(singular)) fail("resource names must be kebab-case, e.g. line-items / line-item");

const pascal = (s) => s.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join("");
const camel = (s) => pascal(s)[0].toLowerCase() + pascal(s).slice(1);
const words = (s) => s.replace(/-/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
const sentence = (s) => words(s)[0].toUpperCase() + words(s).slice(1);

const E = pascal(singular); // LineItem
const Es = pascal(plural); // LineItems
const es = camel(plural); // lineItems
const p = plural; // line-items (URL + dirs)
const noun = words(singular); // line item
const nouns = words(plural); // line items

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
  process.stderr.write(`scaffold-pages: ${msg}\n`);
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

// ------------------------------------------------- read built contracts ----
const contractsDist = path.join(root, "packages/contracts/dist/index.js");
if (!existsSync(contractsDist)) {
  fail("packages/contracts is not built. Run: pnpm --filter @aure/contracts build");
}
const contractSrc = path.join(root, `packages/contracts/src/${p}.ts`);
if (existsSync(contractSrc) && statSync(contractSrc).mtimeMs > statSync(contractsDist).mtimeMs) {
  fail(`packages/contracts/src/${p}.ts is newer than dist. Run: pnpm --filter @aure/contracts build`);
}
const contracts = await import(pathToFileURL(contractsDist).href);
for (const name of [`${E}Schema`, `Create${E}Schema`, `Update${E}Schema`, `${E}ListSchema`, "PageQuerySchema", "IdParamSchema"]) {
  if (!contracts[name]) fail(`@aure/contracts has no ${name}. The API contract for "${p}" must exist first (backend-feature-slice).`);
}

/** Reads a zod 4 schema into { kind, nullable, optional, options }. */
function describe(schema) {
  let s = schema;
  let nullable = false;
  let optional = false;
  for (;;) {
    const def = s._zod.def;
    if (def.type === "optional") optional = true;
    else if (def.type === "nullable") nullable = true;
    else if (["default", "prefault", "readonly", "catch"].includes(def.type)) optional = true;
    else if (def.type === "pipe") {
      s = def.in;
      continue;
    } else break;
    s = def.innerType;
  }
  const def = s._zod.def;
  // zod 4 keeps string formats on the def, but number formats like .int() ("safeint")
  // live in checks; the classic `.format` accessor resolves both.
  const format = s.format ?? def.format ?? def.checks?.map((c) => c._zod.def.format).find(Boolean);
  let kind = "unsupported";
  let options;
  if (def.type === "string") kind = format === "datetime" ? "date" : format === "uuid" ? "uuid" : format === "email" ? "email" : "string";
  else if (def.type === "number") kind = typeof format === "string" && format.includes("int") ? "int" : "number";
  else if (def.type === "boolean") kind = "boolean";
  else if (def.type === "enum") {
    kind = "enum";
    options = Object.values(def.entries);
  }
  return { kind, nullable, optional, options };
}

const entityShape = contracts[`${E}Schema`].shape;
const createShape = contracts[`Create${E}Schema`].shape;
const SYSTEM = new Set(["id", "createdAt", "updatedAt"]);
const display = Object.keys(entityShape)
  .filter((name) => !SYSTEM.has(name))
  .map((name) => ({ name, label: sentence(name), ...describe(entityShape[name]) }));
const formFields = Object.keys(createShape).map((name) => ({ name, label: sentence(name), ...describe(createShape[name]) }));
for (const f of [...display, ...formFields].filter((x) => x.kind === "unsupported")) {
  notes.push(`field "${f.name}" has a type the generator doesn't render; it is skipped. Add it by hand.`);
}
const shown = display.filter((f) => f.kind !== "unsupported");
const inputs = formFields.filter((f) => f.kind !== "unsupported");
if (inputs.length !== formFields.length) {
  notes.push("the form omits unsupported fields, so creating may fail validation until you add them by hand");
}
const labelField =
  shown.find((f) => ["string", "email", "enum"].includes(f.kind) && !f.nullable) ?? shown.find((f) => f.kind === "string");
const listColumns = shown.filter((f) => f !== labelField && f.kind !== "uuid").slice(0, 3);

// ------------------------------------------------------ api-client package --
if (!existsSync(path.join(root, "packages/api-client/package.json"))) {
  write("packages/api-client/package.json", json({
    name: "@aure/api-client",
    version: "0.0.0",
    private: true,
    type: "module",
    exports: {
      ".": {
        import: { types: "./dist/index.d.ts", default: "./dist/index.js" },
        require: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
      },
    },
    scripts: { build: "tsup", typecheck: "tsc --noEmit", lint: "eslint ." },
    // tsup's dts build sets baseUrl internally, which TypeScript 6 rejects as deprecated.
    tsup: {
      entry: ["src/index.ts"],
      format: ["esm", "cjs"],
      dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
      clean: true,
      sourcemap: true,
    },
    dependencies: { "@aure/contracts": "workspace:*", zod: "catalog:" },
    devDependencies: {
      "@aure/config-eslint": "workspace:*",
      "@aure/config-ts": "workspace:*",
      eslint: "catalog:",
      tsup: "catalog:",
      typescript: "catalog:",
    },
  }));
  write("packages/api-client/tsconfig.json", json({
    extends: "@aure/config-ts/library.json",
    compilerOptions: { lib: ["ES2023", "DOM", "DOM.Iterable"] },
    include: ["src"],
  }));
  write("packages/api-client/eslint.config.mjs", `export { default } from "@aure/config-eslint/base";\n`);
  write("packages/api-client/src/index.ts", `
import { type ApiClientOptions, createHttp } from "./http";
// scaffold:imports

export { ApiError, type ApiClientOptions } from "./http";

export function createApiClient(options: ApiClientOptions) {
  const http = createHttp(options);
  return {
    // scaffold:resources
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
`);
  write("packages/api-client/src/http.ts", `
import type { z } from "zod";

export interface ApiClientOptions {
  /** Origin of the API, e.g. http://localhost:3001 */
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(\`API request failed with status \${status}\`);
    this.name = "ApiError";
  }
}

export function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? \`?\${query}\` : "";
}

export function createHttp(options: ApiClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\\/$/, "");

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await doFetch(\`\${base}\${path}\`, init);
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      throw new ApiError(response.status, payload);
    }
    return response;
  }

  return {
    /** Sends a request and validates the JSON response against the contract. */
    async json<T extends z.ZodType>(method: string, path: string, schema: T, body?: unknown): Promise<z.output<T>> {
      const response = await send(method, path, body);
      return schema.parse(await response.json());
    },
    /** Sends a request that returns no body (e.g. 204). */
    async empty(method: string, path: string): Promise<void> {
      await send(method, path);
    },
  };
}

export type Http = ReturnType<typeof createHttp>;
`);
}

write(`packages/api-client/src/${p}.ts`, `
import {
  type Create${E}Input,
  ${E}ListSchema,
  ${E}Schema,
  type PageQuery,
  type Update${E}Input,
} from "@aure/contracts";

import { type Http, toQuery } from "./http";

export function ${es}Client(http: Http) {
  return {
    list: (page: Partial<PageQuery> = {}) => http.json("GET", \`/api/${p}\${toQuery(page)}\`, ${E}ListSchema),
    get: (id: string) => http.json("GET", \`/api/${p}/\${encodeURIComponent(id)}\`, ${E}Schema),
    create: (input: Create${E}Input) => http.json("POST", "/api/${p}", ${E}Schema, input),
    update: (id: string, input: Update${E}Input) =>
      http.json("PATCH", \`/api/${p}/\${encodeURIComponent(id)}\`, ${E}Schema, input),
    remove: (id: string) => http.empty("DELETE", \`/api/${p}/\${encodeURIComponent(id)}\`),
  };
}
`);
edit("packages/api-client/src/index.ts", (s) => {
  if (s.includes(`${es}Client`)) return s;
  if (!s.includes("// scaffold:imports") || !s.includes("// scaffold:resources")) return null;
  return s
    .replace("// scaffold:imports", `import { ${es}Client } from "./${p}";\n// scaffold:imports`)
    .replace(/^(\s*)\/\/ scaffold:resources/m, `$1${es}: ${es}Client(http),\n$1// scaffold:resources`);
});

// ------------------------------------------------- shared web infrastructure --
write("apps/web/src/server/api.ts", `
import { ApiError, createApiClient } from "@aure/api-client";

/**
 * Server-only API access. Import this only from server function modules in
 * src/server/: the API has no CORS, and API_URL is not a public variable.
 */
export function api() {
  return createApiClient({ baseUrl: process.env.API_URL ?? "http://localhost:3001" });
}

export interface FieldIssue {
  path: string;
  message: string;
}

export type MutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string; issues: FieldIssue[] };

/** Turns API errors into data a form can render. Anything unexpected still throws. */
export async function toResult<T>(request: Promise<T>): Promise<MutationResult<T>> {
  try {
    return { ok: true, value: await request };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const body: { message?: unknown; issues?: unknown } =
      typeof error.body === "object" && error.body !== null ? error.body : {};
    const issues: FieldIssue[] = Array.isArray(body.issues) ? body.issues.filter(isFieldIssue) : [];
    const message = typeof body.message === "string" ? body.message : error.message;
    return { ok: false, status: error.status, message, issues };
  }
}

function isFieldIssue(value: unknown): value is FieldIssue {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    typeof value.path === "string" &&
    "message" in value &&
    typeof value.message === "string"
  );
}
`);

write("apps/web/src/components/route-states.tsx", `
import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function RoutePending(): ReactNode {
  return (
    <p role="status" aria-live="polite">
      Loading…
    </p>
  );
}

export function RouteError({ error, reset }: ErrorComponentProps): ReactNode {
  const router = useRouter();
  return (
    <div role="alert">
      <h2>Something went wrong</h2>
      <p>{error instanceof Error ? error.message : "Unexpected error"}</p>
      <button
        type="button"
        onClick={() => {
          reset();
          void router.invalidate();
        }}
      >
        Try again
      </button>
    </div>
  );
}

export function RouteNotFound({ children }: { children?: ReactNode }): ReactNode {
  return (
    <div>
      <h2>Not found</h2>
      <p>{children ?? "This page doesn't exist."}</p>
      <Link to="/">Go home</Link>
    </div>
  );
}
`);

write("apps/web/src/lib/format.ts", `
// All date handling is in UTC so server-rendered and hydrated output match exactly
// (a locale or timezone difference between server and browser causes hydration errors).
const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function formatDateTime(iso: string): string {
  return \`\${dateTime.format(new Date(iso))} UTC\`;
}

/** ISO string -> value for <input type="datetime-local">, in UTC. */
export function toDateTimeLocal(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16);
}

/** <input type="datetime-local"> value, read as UTC -> ISO string. */
export function fromDateTimeLocal(value: string): string {
  return new Date(\`\${value}:00Z\`).toISOString();
}
`);

// ------------------------------------------------------- server functions --
write(`apps/web/src/server/${p}.ts`, `
import { ApiError } from "@aure/api-client";
import { Create${E}Schema, IdParamSchema, PageQuerySchema, Update${E}Schema } from "@aure/contracts";
import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { api, toResult } from "./api";

// Server functions always run on the server, so the API URL and the lack of CORS
// never reach the browser. Loaders and components call these, not the client.

export const list${Es} = createServerFn({ method: "GET" })
  .inputValidator(PageQuerySchema)
  .handler(({ data }) => api().${es}.list(data));

export const get${E} = createServerFn({ method: "GET" })
  .inputValidator(z.object({ id: IdParamSchema }))
  .handler(async ({ data }) => {
    try {
      return await api().${es}.get(data.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) throw notFound();
      throw error;
    }
  });

export const create${E} = createServerFn({ method: "POST" })
  .inputValidator(Create${E}Schema)
  .handler(({ data }) => toResult(api().${es}.create(data)));

export const update${E} = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: IdParamSchema, input: Update${E}Schema }))
  .handler(({ data }) => toResult(api().${es}.update(data.id, data.input)));

export const delete${E} = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: IdParamSchema }))
  .handler(({ data }) => toResult(api().${es}.remove(data.id)));
`);

// ------------------------------------------------------------------ form ----
const usesDates = inputs.some((f) => f.kind === "date");
const initial = (f) => {
  const v = `entity?.${f.name}`;
  switch (f.kind) {
    case "boolean":
      return `${v} ?? false`;
    case "int":
    case "number":
      return `entity === undefined || entity.${f.name} === null ? "" : String(entity.${f.name})`;
    case "date":
      return `entity?.${f.name} ? toDateTimeLocal(entity.${f.name}) : ""`;
    default:
      return `${v} ?? ""`;
  }
};
const toInputExpr = (f) => {
  const v = `values.${f.name}`;
  const empty = f.nullable ? "null" : "undefined";
  switch (f.kind) {
    case "boolean":
      return v;
    case "int":
    case "number":
      return `${v} === "" ? ${empty} : Number(${v})`;
    case "date":
      return `${v} === "" ? ${empty} : fromDateTimeLocal(${v})`;
    case "string":
    case "email":
      return f.nullable ? `${v} === "" ? null : ${v}` : v;
    default:
      return `${v} === "" ? ${empty} : ${v}`;
  }
};
const fieldJsx = (f) => {
  const key = f.name;
  const ids = `\`\${id}-${key}\``;
  const errId = `\`\${id}-${key}-error\``;
  const aria = `aria-invalid={errors.${key} ? true : undefined}
          aria-describedby={errors.${key} ? ${errId} : undefined}`;
  const error = `{errors.${key} ? <p id={${errId}}>{errors.${key}}</p> : null}`;
  const req = f.nullable || f.optional || f.kind === "boolean" ? "" : `\n          aria-required="true"`;
  if (f.kind === "boolean") {
    return `
      <div>
        <input
          id={${ids}}
          name="${key}"
          type="checkbox"
          checked={values.${key}}
          onChange={(event) => set("${key}", event.target.checked)}
          ${aria}
        />
        <label htmlFor={${ids}}>${f.label}</label>
        ${error}
      </div>`;
  }
  if (f.kind === "enum") {
    return `
      <div>
        <label htmlFor={${ids}}>${f.label}</label>
        <select
          id={${ids}}
          name="${key}"
          value={values.${key}}
          onChange={(event) => set("${key}", event.target.value)}
          ${aria}${req}
        >
          <option value="">${f.nullable ? "None" : "Select…"}</option>
${f.options.map((o) => `          <option value="${o}">${sentence(String(o))}</option>`).join("\n")}
        </select>
        ${error}
      </div>`;
  }
  const type = { int: "number", number: "number", date: "datetime-local", email: "email" }[f.kind] ?? "text";
  const extra =
    f.kind === "int" ? `\n          inputMode="numeric"\n          step={1}` : f.kind === "number" ? `\n          step="any"` : "";
  const label = f.kind === "date" ? `${f.label} (UTC)` : f.label;
  return `
      <div>
        <label htmlFor={${ids}}>${label}</label>
        <input
          id={${ids}}
          name="${key}"
          type="${type}"${extra}
          value={values.${key}}
          onChange={(event) => set("${key}", event.target.value)}
          ${aria}${req}
        />
        ${error}
      </div>`;
};

write(`apps/web/src/components/${p}/${singular}-form.tsx`, `
import {
  type Create${E}Input,
  Create${E}Schema,
  type ${E},
  type Update${E}Input,
  Update${E}Schema,
} from "@aure/contracts";
import { type FormEvent, type ReactNode, useId, useState } from "react";

${usesDates ? `import { fromDateTimeLocal, toDateTimeLocal } from "../../lib/format";\n` : ""}import type { FieldIssue, MutationResult } from "../../server/api";

interface Values {
${inputs.map((f) => `  ${f.name}: ${f.kind === "boolean" ? "boolean" : "string"};`).join("\n")}
}
type Errors = Partial<Record<keyof Values | "form", string>>;

const FIELDS: Record<keyof Values, true> = {
${inputs.map((f) => `  ${f.name}: true,`).join("\n")}
};

function initialValues(entity?: ${E}): Values {
  return {
${inputs.map((f) => `    ${f.name}: ${initial(f)},`).join("\n")}
  };
}

/** Form strings -> the shape the contract schema validates. */
function toInput(values: Values): Record<keyof Values, unknown> {
  return {
${inputs.map((f) => `    ${f.name}: ${toInputExpr(f)},`).join("\n")}
  };
}

/** Only the fields that differ from the loaded entity, for PATCH. */
function changes(values: Values, entity: ${E}): Partial<Record<keyof Values, unknown>> {
  const next = toInput(values);
  const before = toInput(initialValues(entity));
  const patch: Partial<Record<keyof Values, unknown>> = {};
  for (const key of Object.keys(FIELDS) as (keyof Values)[]) {
    if (JSON.stringify(next[key]) !== JSON.stringify(before[key])) patch[key] = next[key];
  }
  return patch;
}

function toErrors(issues: readonly FieldIssue[], fallback?: string): Errors {
  const errors: Errors = {};
  for (const issue of issues) {
    const key = issue.path.split(".")[0] ?? "";
    if (key in FIELDS) errors[key as keyof Values] ??= issue.message;
    else errors.form ??= issue.message;
  }
  if (issues.length === 0 && fallback !== undefined) errors.form = fallback;
  return errors;
}

const zodIssues = (issues: readonly { path: PropertyKey[]; message: string }[]): FieldIssue[] =>
  issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));

type Props = { submitLabel: string } & (
  | { mode: "create"; onSubmit: (input: Create${E}Input) => Promise<MutationResult<${E}>> }
  | { mode: "edit"; entity: ${E}; onSubmit: (input: Update${E}Input) => Promise<MutationResult<${E}>> }
);

export function ${E}Form(props: Props): ReactNode {
  const id = useId();
  const [values, setValues] = useState(() => initialValues(props.mode === "edit" ? props.entity : undefined));
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);

  function set<K extends keyof Values>(key: K, value: Values[K]): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrors({});
    let result: MutationResult<${E}>;
    if (props.mode === "create") {
      const parsed = Create${E}Schema.safeParse(toInput(values));
      if (!parsed.success) return void setErrors(toErrors(zodIssues(parsed.error.issues)));
      setSubmitting(true);
      result = await props.onSubmit(parsed.data);
    } else {
      const parsed = Update${E}Schema.safeParse(changes(values, props.entity));
      if (!parsed.success) return void setErrors(toErrors(zodIssues(parsed.error.issues)));
      setSubmitting(true);
      result = await props.onSubmit(parsed.data);
    }
    setSubmitting(false);
    if (!result.ok) setErrors(toErrors(result.issues, result.message));
  }

  return (
    <form noValidate onSubmit={(event) => void handleSubmit(event)}>
${inputs.map(fieldJsx).join("\n")}
      {errors.form ? <p role="alert">{errors.form}</p> : null}
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : props.submitLabel}
      </button>
    </form>
  );
}
`);

// ---------------------------------------------------------------- routes ----
const cell = (f, v) => {
  const val = `${v}.${f.name}`;
  if (f.kind === "boolean") return `${val} ? "Yes" : "No"`;
  if (f.kind === "date") return f.nullable ? `${val} === null ? "—" : formatDateTime(${val})` : `formatDateTime(${val})`;
  return f.nullable ? `${val} ?? "—"` : val;
};
const titleOf = (v) => (labelField ? (labelField.nullable ? `${v}.${labelField.name} ?? ${v}.id` : `${v}.${labelField.name}`) : `${v}.id`);
const listNeedsFormat = listColumns.some((f) => f.kind === "date") || true; // createdAt column
const detailNeedsFormat = true;

write(`apps/web/src/routes/${p}/index.tsx`, `
import { PageQuerySchema } from "@aure/contracts";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { RouteError, RoutePending } from "../../components/route-states";
${listNeedsFormat ? `import { formatDateTime } from "../../lib/format";\n` : ""}import { list${Es} } from "../../server/${p}";

export const Route = createFileRoute("/${p}/")({
  validateSearch: PageQuerySchema,
  // Keep default paging out of the URL, so /${p} doesn't redirect to ?limit=50&offset=0.
  search: { middlewares: [stripSearchParams(PageQuerySchema.parse({}))] },
  loaderDeps: ({ search }) => ({ limit: search.limit, offset: search.offset }),
  loader: ({ deps }) => list${Es}({ data: deps }),
  head: () => ({ meta: [{ title: "${sentence(plural)} · aure" }] }),
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  component: ${Es}ListPage,
});

function ${Es}ListPage(): ReactNode {
  const page = Route.useLoaderData();
  const { limit, offset } = page;
  return (
    <main>
      <h1>${sentence(plural)}</h1>
      <p>
        <Link to="/${p}/new">New ${noun}</Link>
      </p>
      {page.items.length === 0 ? (
        <p>No ${nouns} yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">${labelField ? labelField.label : "Id"}</th>
${listColumns.map((f) => `              <th scope="col">${f.label}</th>`).join("\n")}
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link to="/${p}/$id" params={{ id: item.id }}>
                    {${titleOf("item")}}
                  </Link>
                </td>
${listColumns.map((f) => `                <td>{${cell(f, "item")}}</td>`).join("\n")}
                <td>{formatDateTime(item.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <nav aria-label="Pagination">
        {offset > 0 ? (
          <Link to="/${p}" search={{ limit, offset: Math.max(0, offset - limit) }}>
            Previous
          </Link>
        ) : null}{" "}
        {page.items.length === limit ? (
          <Link to="/${p}" search={{ limit, offset: offset + limit }}>
            Next
          </Link>
        ) : null}
      </nav>
    </main>
  );
}
`);

write(`apps/web/src/routes/${p}/new.tsx`, `
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";

import { ${E}Form } from "../../components/${p}/${singular}-form";
import { create${E} } from "../../server/${p}";

export const Route = createFileRoute("/${p}/new")({
  head: () => ({ meta: [{ title: "New ${noun} · aure" }] }),
  component: New${E}Page,
});

function New${E}Page(): ReactNode {
  const create = useServerFn(create${E});
  const navigate = useNavigate();
  const router = useRouter();
  return (
    <main>
      <p>
        <Link to="/${p}">← All ${nouns}</Link>
      </p>
      <h1>New ${noun}</h1>
      <${E}Form
        mode="create"
        submitLabel="Create ${noun}"
        onSubmit={async (input) => {
          const result = await create({ data: input });
          if (result.ok) {
            await router.invalidate();
            await navigate({ to: "/${p}/$id", params: { id: result.value.id } });
          }
          return result;
        }}
      />
    </main>
  );
}
`);

const notFoundText = `That ${noun} doesn't exist or was deleted.`;
write(`apps/web/src/routes/${p}/$id/index.tsx`, `
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type ReactNode, useState } from "react";

import { RouteError, RouteNotFound, RoutePending } from "../../../components/route-states";
${detailNeedsFormat ? `import { formatDateTime } from "../../../lib/format";\n` : ""}import { delete${E}, get${E} } from "../../../server/${p}";

export const Route = createFileRoute("/${p}/$id/")({
  loader: ({ params }) => get${E}({ data: { id: params.id } }),
  head: ({ loaderData }) => ({
    meta: [{ title: \`\${loaderData ? ${titleOf("loaderData")} : "${sentence(singular)}"} · aure\` }],
  }),
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  notFoundComponent: () => <RouteNotFound>${notFoundText}</RouteNotFound>,
  component: ${E}DetailPage,
});

function ${E}DetailPage(): ReactNode {
  const item = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const remove = useServerFn(delete${E});
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete(): Promise<void> {
    setDeleting(true);
    setError(null);
    const result = await remove({ data: { id: item.id } });
    if (!result.ok) {
      setDeleting(false);
      setError(result.message);
      return;
    }
    await router.invalidate();
    await navigate({ to: "/${p}" });
  }

  return (
    <main>
      <p>
        <Link to="/${p}">← All ${nouns}</Link>
      </p>
      <h1>{${titleOf("item")}}</h1>
      <dl>
${shown.map((f) => `        <dt>${f.label}</dt>\n        <dd>{${cell(f, "item")}}</dd>`).join("\n")}
        <dt>Created</dt>
        <dd>{formatDateTime(item.createdAt)}</dd>
        <dt>Updated</dt>
        <dd>{formatDateTime(item.updatedAt)}</dd>
      </dl>
      <p>
        <Link to="/${p}/$id/edit" params={{ id: item.id }}>
          Edit
        </Link>
      </p>
      {confirming ? (
        <div role="group" aria-label="Confirm delete">
          <p>Delete this ${noun}? This can't be undone.</p>
          <button type="button" onClick={() => void handleDelete()} disabled={deleting}>
            {deleting ? "Deleting…" : "Yes, delete"}
          </button>{" "}
          <button type="button" onClick={() => setConfirming(false)} disabled={deleting}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)}>
          Delete
        </button>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </main>
  );
}
`);

write(`apps/web/src/routes/${p}/$id/edit.tsx`, `
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";

import { ${E}Form } from "../../../components/${p}/${singular}-form";
import { RouteError, RouteNotFound, RoutePending } from "../../../components/route-states";
import { get${E}, update${E} } from "../../../server/${p}";

export const Route = createFileRoute("/${p}/$id/edit")({
  loader: ({ params }) => get${E}({ data: { id: params.id } }),
  head: ({ loaderData }) => ({
    meta: [{ title: \`Edit \${loaderData ? ${titleOf("loaderData")} : "${noun}"} · aure\` }],
  }),
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  notFoundComponent: () => <RouteNotFound>${notFoundText}</RouteNotFound>,
  component: Edit${E}Page,
});

function Edit${E}Page(): ReactNode {
  const item = Route.useLoaderData();
  const update = useServerFn(update${E});
  const navigate = useNavigate();
  const router = useRouter();
  return (
    <main>
      <p>
        <Link to="/${p}/$id" params={{ id: item.id }}>
          ← Back
        </Link>
      </p>
      <h1>Edit {${titleOf("item")}}</h1>
      <${E}Form
        mode="edit"
        entity={item}
        submitLabel="Save changes"
        onSubmit={async (input) => {
          const result = await update({ data: { id: item.id, input } });
          if (result.ok) {
            await router.invalidate();
            await navigate({ to: "/${p}/$id", params: { id: item.id } });
          }
          return result;
        }}
      />
    </main>
  );
}
`);

// --------------------------------------------------- web config touch-ups --
edit("apps/web/package.json", (s) => {
  const pkg = JSON.parse(s);
  pkg.dependencies ??= {};
  const want = { "@aure/api-client": "workspace:*", "@aure/contracts": "workspace:*", zod: "catalog:" };
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

// Server functions read process.env, so the app needs Node types next to vite/client.
edit("apps/web/tsconfig.json", (s) => {
  const tsconfig = JSON.parse(s);
  tsconfig.compilerOptions ??= {};
  const types = tsconfig.compilerOptions.types ?? ["vite/client"];
  if (types.includes("node")) return s;
  tsconfig.compilerOptions.types = [...types, "node"];
  const { extends: ext, compilerOptions, ...rest } = tsconfig;
  return json({ extends: ext, compilerOptions, ...rest });
});

// API_URL is runtime-only: pass it through without making it a cache key.
edit("turbo.json", (s) => {
  const turbo = JSON.parse(s);
  const list = (turbo.globalPassThroughEnv ??= []);
  if (list.includes("API_URL")) return s;
  list.push("API_URL");
  return json(turbo);
});

// ------------------------------------------------------------- report ----
const out = [];
out.push(`${dryRun ? "[dry run] " : ""}pages for "${p}" (${E})`);
out.push(
  `fields: ${inputs.map((f) => `${f.name}:${f.kind}${f.nullable ? "?" : ""}${f.options ? `[${f.options.join("|")}]` : ""}`).join(", ")}`,
);
if (created.length) out.push(`created:\n${created.map((x) => `  + ${x}`).join("\n")}`);
if (edited.length) out.push(`edited:\n${edited.map((x) => `  ~ ${x}`).join("\n")}`);
if (skipped.length) out.push(`skipped (already exist):\n${skipped.map((x) => `  = ${x}`).join("\n")}`);
if (notes.length) out.push(`ACTION NEEDED:\n${notes.map((x) => `  ! ${x}`).join("\n")}`);
out.push(`routes: /${p}, /${p}/new, /${p}/$id, /${p}/$id/edit`);
out.push("next: pnpm install, then pnpm turbo run build typecheck lint --force (build regenerates routeTree.gen.ts)");
process.stdout.write(out.join("\n") + "\n");
