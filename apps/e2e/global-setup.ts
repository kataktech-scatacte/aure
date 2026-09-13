import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stack = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/stack.mjs");

interface StackStatus {
  services: { name: string; running: boolean; required: boolean }[];
  ready: boolean;
  partial: boolean;
}

function runStack(...args: string[]): string {
  // Capture both streams instead of inheriting this process's stderr. A service the
  // stack leaves running must never hold the caller's terminal or pipe handle: on
  // Windows that keeps pipelines like `playwright test | tee log` open forever.
  try {
    return execFileSync(process.execPath, [stack, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    throw new Error(`scripts/stack.mjs ${args.join(" ")} failed:\n${stdout}${stderr}`.trimEnd(), { cause: error });
  }
}

/**
 * Makes sure a complete stack is running and returns the teardown.
 * - Both E2E_API_URL and E2E_WEB_URL set: test an external environment, start nothing.
 *   Exactly one set (empty counts as unset) is an error.
 * - DATABASE_URL set in the environment: refused unless E2E_ALLOW_EXTERNAL_DB=1, because
 *   the stack would run the suite against that database, creating test data in it.
 *   When allowed, migrations are applied to it before the run.
 * - Nothing running: start a fresh stack for this run and stop it afterwards.
 * - Complete stack already running: reuse it and leave it running. It serves the
 *   build it was started with, not necessarily the one turbo just made.
 * - Partially running: fail with instructions. Setup never starts services that
 *   outlive the run: on Windows such a process inherits the runner's output handles,
 *   so `playwright test | tee log` would never finish. It also never wipes the
 *   running database with --fresh.
 */
export default function globalSetup(): () => void {
  // Empty strings (e.g. CI variables that expand to nothing) count as unset.
  const apiUrl = process.env.E2E_API_URL || undefined;
  const webUrl = process.env.E2E_WEB_URL || undefined;
  if (apiUrl && webUrl) return () => undefined;
  if (apiUrl || webUrl) {
    throw new Error("Set both E2E_API_URL and E2E_WEB_URL to test an external environment, or neither to use scripts/stack.mjs.");
  }
  if (process.env.DATABASE_URL && process.env.E2E_ALLOW_EXTERNAL_DB !== "1") {
    throw new Error(
      "DATABASE_URL is set, so the stack would run the e2e suite against that database and write test data to it. " +
        "Unset DATABASE_URL to use a throwaway database, or set E2E_ALLOW_EXTERNAL_DB=1 if that database is meant for tests.",
    );
  }

  const status = JSON.parse(runStack("status", "--json")) as StackStatus;
  if (status.ready) {
    process.stdout.write("e2e: reusing the running stack (it serves the build it was started with)\n");
    return () => undefined;
  }
  if (status.partial) {
    const running = status.services.filter((s) => s.running).map((s) => s.name);
    const missing = status.services.filter((s) => s.required && !s.running).map((s) => s.name);
    throw new Error(
      `The stack is partially running (running: ${running.join(", ")}; missing: ${missing.join(", ")}). ` +
        "Run `node scripts/stack.mjs up` to start the missing services and reuse them, " +
        "or `node scripts/stack.mjs down` to let the tests start a fresh stack.",
    );
  }

  // stack.mjs stops anything it started if `up` fails, so a throw here leaves nothing behind.
  // An opted-in external database is migrated first: the suite needs the current schema,
  // and opting in declares that database as disposable test data.
  const externalDb = Boolean(process.env.DATABASE_URL);
  process.stdout.write(runStack("up", "--fresh", ...(externalDb ? ["--migrate"] : [])));
  return () => {
    process.stdout.write(runStack("down"));
  };
}
