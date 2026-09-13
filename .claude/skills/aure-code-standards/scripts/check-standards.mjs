#!/usr/bin/env node
// Mechanical checks for aure's code standards: naming, file structure, and
// patterns ESLint doesn't catch. It complements lint/typecheck; it does not replace
// judgment-based review.
//
//   node check-standards.mjs                 changed + untracked files (git); every file outside a git checkout
//   node check-standards.mjs --all           every tracked or untracked, non-ignored file (the whole tree without git)
//   node check-standards.mjs <path>...       specific files or directories
//   add --json for machine-readable output
//
// Exit code 1 when a blocker is found.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const all = argv.includes("--all");
const explicit = argv.filter((a) => !a.startsWith("--"));

const root = (() => {
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, "pnpm-workspace.yaml"))) return d;
    if (path.dirname(d) === d) throw new Error("run inside the aure repo");
  }
})();

const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const IGNORED = /(^|\/)(node_modules|dist|\.output|\.tanstack|\.turbo|\.stack|test-results|playwright-report|\.git)(\/|$)|routeTree\.gen\.ts$|pnpm-lock\.yaml$/;

function walk(rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs) || IGNORED.test(rel)) return [];
  if (statSync(abs).isFile()) return [rel];
  return readdirSync(abs).flatMap((name) => walk(path.posix.join(rel, name)));
}

const inGit = git("rev-parse", "--is-inside-work-tree")[0] === "true";
let files;
if (explicit.length) {
  files = explicit.flatMap((p) => walk(path.relative(root, path.resolve(p)).split(path.sep).join("/")));
} else if (all || !inGit) {
  // Outside a git checkout (an export, a CI artifact) there is no "changed" set and git
  // lists nothing: check the whole tree instead of silently checking zero files.
  if (!all) process.stderr.write("check-standards: not a git checkout; checking all files\n");
  files = inGit ? git("ls-files", "--cached", "--others", "--exclude-standard") : walk(".");
} else {
  const hasHead = git("rev-parse", "--verify", "HEAD").length > 0;
  files = [
    ...(hasHead ? git("diff", "--name-only", "HEAD") : []),
    ...git("ls-files", "--others", "--exclude-standard"),
  ];
}
files = [...new Set(files)].filter((f) => !IGNORED.test(f) && !f.startsWith(".claude/") && existsSync(path.join(root, f)));
const modified = new Set(
  git("status", "--porcelain").filter((l) => /^( M|M |MM)/.test(l)).map((l) => l.slice(3)),
);

// ---------------------------------------------------------------- rules ----
const findings = [];
const add = (severity, rule, file, line, message) => findings.push({ severity, rule, file, line, message });
const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const eachMatch = (text, re, fn) => {
  for (const m of text.matchAll(re)) fn(m, lineOf(text, m.index));
};

const KEBAB_SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const API_ROLES = new Set(["module", "controller", "service", "repository", "mapper"]);

for (const file of files) {
  const ext = path.posix.extname(file);
  const base = path.posix.basename(file);
  const isTs = ext === ".ts" || ext === ".tsx";
  const inSrc = /^(apps|packages)\/[^/]+\/src\//.test(file);
  const inE2eTests = file.startsWith("apps/e2e/tests/");
  const text = isTs || ext === ".sql" || base === "package.json" ? readFileSync(path.join(root, file), "utf8") : "";

  // naming/kebab-case: source files and folders
  if ((inSrc || inE2eTests) && isTs) {
    const rel = file.replace(/^(apps|packages)\/[^/]+\/src\//, "").replace(/^apps\/e2e\/tests\//, "");
    const parts = rel.split("/");
    for (const [i, part] of parts.entries()) {
      const isFile = i === parts.length - 1;
      if (part === "__root.tsx" || part.startsWith("$")) continue;
      const segments = (isFile ? part.replace(/\.(tsx?|d\.ts)$/, "") : part).split(".");
      if (!segments.every((s) => KEBAB_SEGMENT.test(s))) {
        add("major", "naming/kebab-case", file, 1, `"${part}" must be kebab-case (dot-separated role suffixes allowed, e.g. orders.service.ts)`);
        break;
      }
    }
  }

  // structure/api-feature-files: apps/api/src/<feature>/<feature>.<role>.ts
  const apiFeature = /^apps\/api\/src\/([^/]+)\/([^/]+)\.ts$/.exec(file);
  if (apiFeature && !["common", "db"].includes(apiFeature[1])) {
    const [, dir, name] = apiFeature;
    const [prefix, role, ...extra] = name.split(".");
    if (prefix !== dir || !API_ROLES.has(role) || extra.length) {
      add("major", "structure/api-feature-files", file, 1, `feature files are named ${dir}.<module|controller|service|repository|mapper>.ts`);
    }
  }

  if (isTs && !file.endsWith(".d.ts")) {
    // code/no-any
    eachMatch(text, /(:\s*any\b|\bas\s+any\b|<any>)/g, (m, line) => add("major", "code/no-any", file, line, "`any` disables type checking; use `unknown` and narrow, or a precise type"));
    // code/console in app and package source
    if (inSrc) eachMatch(text, /\bconsole\.(log|debug|info|trace)\(/g, (m, line) => add("minor", "code/console", file, line, `console.${m[1]} in source; remove it or use Nest's Logger in apps/api`));
    // code/eslint-disable needs a reason; layering rules may never be disabled
    eachMatch(text, /eslint-disable(?:-next-line|-line)?([^\n*]*)/g, (m, line) => {
      if (/no-restricted-imports/.test(m[1])) add("blocker", "code/eslint-disable-layering", file, line, "disabling the import-boundary rule breaks the architecture; restructure instead");
      else if (!/\s--\s\S/.test(m[1])) add("minor", "code/eslint-disable-reason", file, line, 'eslint-disable needs a reason: `// eslint-disable-next-line <rule> -- <why>`');
    });
    // zod/deprecated-api (zod 4)
    eachMatch(text, /z\.string\(\)(?:\.\w+\([^()]*\))*\.(uuid|email|url|datetime|date|time|ipv4|ipv6|cuid|cuid2|ulid|nanoid|base64|jwt)\(/g, (m, line) =>
      add("minor", "zod/deprecated-api", file, line, `z.string().${m[1]}() is deprecated in zod 4; use ${m[1] === "datetime" || m[1] === "date" || m[1] === "time" ? `z.iso.${m[1]}()` : `z.${m[1]}()`}`),
    );
    eachMatch(text, /\.flatten\(\)/g, (m, line) => add("minor", "zod/deprecated-api", file, line, "error.flatten() is deprecated in zod 4; use z.flattenError(error) or error.issues"));
  }

  // apps/api: import type of a class injected through the constructor breaks DI at runtime
  if (file.startsWith("apps/api/src/") && isTs) {
    const typeOnly = new Set();
    eachMatch(text, /import\s+type\s*\{([^}]*)\}/g, (m) => m[1].split(",").forEach((n) => typeOnly.add(n.trim().split(/\s+as\s+/).pop())));
    eachMatch(text, /import\s*\{([^}]*)\}/g, (m) =>
      m[1].split(",").map((n) => n.trim()).filter((n) => n.startsWith("type ")).forEach((n) => typeOnly.add(n.slice(5).trim().split(/\s+as\s+/).pop())),
    );
    const ctor = /constructor\s*\(([\s\S]*?)\)\s*\{/.exec(text);
    if (ctor && typeOnly.size) {
      for (const param of ctor[1].split(/,(?![^<]*>)/)) {
        const typed = /:\s*([A-Z]\w*)\s*$/.exec(param.trim());
        if (typed && typeOnly.has(typed[1]) && !/@Inject\(/.test(param)) {
          add("blocker", "nest/type-import-injected", file, lineOf(text, ctor.index), `${typed[1]} is injected by type but imported with \`type\`; emitDecoratorMetadata emits Object and DI fails at runtime`);
        }
      }
    }
    // SQL built with interpolation: only constants and generated placeholders are allowed
    if (file.endsWith(".repository.ts")) {
      eachMatch(text, /`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`]*`/gi, (m, line) => {
        for (const expr of m[0].matchAll(/\$\{([^}]*)\}/g)) {
          const e = expr[1].trim();
          if (/^[A-Z][A-Z0-9_]*$/.test(e) || /^sets\.join\(/.test(e) || /^values\.length$/.test(e)) continue;
          add("major", "sql/interpolation", file, line, `\${${e}} interpolated into SQL; values must be $n parameters and identifiers must come from constants`);
        }
      });
    }
  }

  // apps/web boundaries: the API is only reachable from server functions
  if (file.startsWith("apps/web/src/") && isTs) {
    const serverSide = file.startsWith("apps/web/src/server/");
    if (!serverSide) {
      eachMatch(text, /from\s+["']@aure\/api-client["']/g, (m, line) => add("blocker", "web/api-client-outside-server", file, line, "@aure/api-client may only be used in src/server (browsers can't reach the API)"));
      eachMatch(text, /\bprocess\.env\b/g, (m, line) => add("blocker", "web/process-env-outside-server", file, line, "process.env outside src/server can leak into the browser bundle; read env in server functions"));
      eachMatch(text, /\bcreateServerFn\s*\(/g, (m, line) => add("major", "web/server-fn-location", file, line, "server functions live in src/server/<resource>.ts"));
    }
    if (/^apps\/web\/src\/routes\//.test(file)) {
      eachMatch(text, /toLocale(Date|Time)?String\(/g, (m, line) => add("major", "web/locale-date", file, line, "locale/timezone-dependent formatting causes hydration mismatches; use src/lib/format.ts (UTC)"));
    }
  }

  // packages/contracts naming
  if (/^packages\/contracts\/src\/.+\.ts$/.test(file)) {
    eachMatch(text, /export\s+const\s+(\w+)\s*=\s*z\./g, (m, line) => {
      if (!m[1].endsWith("Schema")) add("minor", "contracts/schema-name", file, line, `exported zod schema "${m[1]}" should end in Schema (type alias without the suffix)`);
    });
  }

  // migrations
  if (/^packages\/db\/migrations\/[^/]+\.sql$/.test(file)) {
    if (!/^\d{14}_[a-z][a-z0-9_]*\.sql$/.test(base)) add("major", "migrations/name", file, 1, "migration files are named YYYYMMDDHHMMSS_verb_object.sql");
    if (modified.has(file)) add("major", "migrations/edited", file, 1, "an existing migration was modified; if it may have been applied anywhere, add a new migration instead");
  }

  // e2e
  if (/^apps\/e2e\/tests\/.+\.spec\.ts$/.test(file)) {
    eachMatch(text, /\b(test|describe)(\.describe)?\.only\s*\(/g, (m, line) => add("blocker", "e2e/only", file, line, ".only would skip the rest of the suite (CI forbids it)"));
    eachMatch(text, /waitForTimeout\s*\(/g, (m, line) => add("major", "e2e/sleep", file, line, "fixed sleeps cause flakes; use web-first assertions"));
    if (file.startsWith("apps/e2e/tests/web/")) {
      eachMatch(text, /from\s+["']@playwright\/test["']/g, (m, line) => add("major", "e2e/web-fixtures", file, line, 'web specs import test/expect from "./fixtures" (console-error checks)'));
      eachMatch(text, /\bpage\.goto\s*\(/g, (m, line) => add("major", "e2e/goto-hydrated", file, line, "use gotoHydrated(page, url) so interactions wait for hydration"));
    }
  }

  // catalog, named catalogs and override versions are exact pins (ranges float)
  if (file === "pnpm-workspace.yaml") {
    const wsText = readFileSync(path.join(root, file), "utf8");
    const EXACT = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
    const NPM_ALIAS = /^npm:(@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+(-[\w.]+)?$/;
    let section = null;
    for (const [i, raw] of wsText.split(/\r?\n/).entries()) {
      const top = /^([A-Za-z][\w-]*):/.exec(raw);
      if (top) {
        section = top[1];
        continue;
      }
      if (!["catalog", "catalogs", "overrides"].includes(section)) continue;
      if (!raw.trim() || raw.trim().startsWith("#")) continue; // blank or comment line
      // Key: bare or quoted with ' or " (scopes, "a>b" override selectors). Value: everything up to an
      // inline " #comment", so ranges with spaces ("^1 || ^2", ">=1 <2") are captured whole.
      const entry = /^\s+(["'])(.+?)\1:(.*)$|^\s+([^"'\s][^:]*?):(.*)$/.exec(raw);
      if (!entry) continue;
      const key = entry[2] ?? entry[4];
      let value = (entry[3] ?? entry[5]).replace(/\s+#.*$/, "").trim();
      const quoted = /^(["'])(.*)\1$/.exec(value);
      if (!quoted && !value) continue; // named-catalog header ("  legacy:")
      if (quoted) value = quoted[2];
      const ok = EXACT.test(value) || (section === "overrides" && (value === "-" || NPM_ALIAS.test(value)));
      if (!ok) add("major", "deps/catalog-specifier", file, i + 1, `${section} entry ${key}: "${value}" must be an exact version`);
    }
  }

  // dependency specifiers: exact pins, catalog:, or workspace:*
  if (base === "package.json" && /^(apps|packages)\/[^/]+\/package\.json$|^package\.json$/.test(file)) {
    const pkg = JSON.parse(text);
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (spec === "catalog:" || spec.startsWith("workspace:") || /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(spec)) continue;
        if (field === "peerDependencies") continue;
        add("major", "deps/specifier", file, lineOf(text, text.indexOf(`"${name}"`)), `${name}@"${spec}": use "catalog:" for shared versions, an exact pin, or "workspace:*"`);
      }
    }
  }
}

// --------------------------------------------------------------- output ----
const order = { blocker: 0, major: 1, minor: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
if (asJson) {
  process.stdout.write(JSON.stringify({ checkedFiles: files.length, findings }, null, 2) + "\n");
} else {
  process.stdout.write(`checked ${files.length} files: ${findings.length} finding(s)\n`);
  for (const f of findings) process.stdout.write(`${f.severity.padEnd(7)} ${f.file}:${f.line}  [${f.rule}] ${f.message}\n`);
}
process.exit(findings.some((f) => f.severity === "blocker") ? 1 : 0);
