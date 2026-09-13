#!/usr/bin/env node
// Local full stack for verification and e2e tests:
//   throwaway Postgres cluster -> migrations -> built API -> built web app
//
//   node scripts/stack.mjs up [--fresh] [--no-db] [--no-api] [--no-web] [--migrate]
//   node scripts/stack.mjs down [--clean]
//   node scripts/stack.mjs status [--json]
//
// Everything lives in .stack/ (gitignored): pgdata, logs, state.json.
// Processes are started detached, so they outlive the shell that ran `up`;
// always pair `up` with `down`. A failed or interrupted `up` stops whatever it
// started (a second Ctrl+C exits immediately).
//
// Ports: STACK_PG_PORT (55432), STACK_API_PORT (3457), STACK_WEB_PORT (3100).
// If DATABASE_URL is set, no local Postgres is started and migrations only run
// with --migrate (never migrate a shared database by accident).
// Requires built apps: pnpm turbo run build

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.join(root, ".stack");
const stateFile = path.join(stateDir, "state.json");
const dataDir = path.join(stateDir, "pgdata");
const isWin = process.platform === "win32";
const hasDbPackage = existsSync(path.join(root, "packages/db/migrate.mjs"));
const RM_RETRIES = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };

const ports = {
  pg: Number(process.env.STACK_PG_PORT ?? 55432),
  api: Number(process.env.STACK_API_PORT ?? 3457),
  web: Number(process.env.STACK_WEB_PORT ?? 3100),
};
const executableName = (file) => path.basename(file).toLowerCase().replace(/\.exe$/, "");
/**
 * Executable name each service runs as, used to tell our processes from reused PIDs.
 * api and web run under this very Node binary, whatever it's called (node, nodejs, …).
 */
const IMAGE = { pg: "postgres", api: executableName(process.execPath), web: executableName(process.execPath) };

const [command, ...rest] = process.argv.slice(2);
const has = (name) => rest.includes(`--${name}`);

class StackError extends Error {}
const log = (msg) => process.stdout.write(`stack: ${msg}\n`);
const fail = (msg) => {
  throw new StackError(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Set by a SIGINT/SIGTERM during `up`; the start flow checks it at every step.
let interrupted = null;
const checkInterrupted = () => {
  if (interrupted) fail(`interrupted by ${interrupted}`);
};

// ------------------------------------------------------------- helpers ----
function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}
function writeState(state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
}
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
/** Executable name of a running PID ("node", "postgres"), or null. */
function imageOf(pid) {
  if (isWin) {
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout ?? "";
    const first = /^"([^"]+)"/.exec(out.trim())?.[1];
    return first ? executableName(first) : null;
  }
  const out = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).stdout?.trim();
  return out ? executableName(out) : null;
}
/** Start time of a running process in epoch seconds, or null. */
function processStartSeconds(pid) {
  if (isWin) {
    const out = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeSeconds()`],
      { encoding: "utf8" },
    ).stdout?.trim();
    return out && /^\d+$/.test(out) ? Number(out) : null;
  }
  const out = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).stdout?.trim();
  const ms = out ? Date.parse(out) : NaN;
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
/** Lines of OUR cluster's postmaster.pid: [pid, dataDir, startEpochSeconds, port, …], or null. */
function postmasterInfo() {
  try {
    const lines = readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n");
    return { pid: Number(lines[0]), startedAt: Number(lines[2]), port: Number(lines[3]) };
  } catch {
    return null;
  }
}
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
/**
 * True only if the recorded process verifiably belongs to this stack right now.
 * PIDs are reused by the OS (quickly on Windows), and both state.json and
 * postmaster.pid survive crashes and reboots, so no file alone is trusted:
 * - api/web: alive, running this Node binary, and holding the recorded port
 * - postgres: alive, a postgres process, holding the recorded port, and matching
 *   postmaster.pid's PID, port AND start time (within 5s of the process start time),
 *   which a reused PID from another server cannot match
 */
async function isOurs(name, entry) {
  if (!entry?.pid || !alive(entry.pid) || imageOf(entry.pid) !== IMAGE[name]) return false;
  if (!(await portInUse(entry.port))) return false;
  if (name !== "pg") return true;
  const pm = postmasterInfo();
  if (!pm || pm.pid !== entry.pid || pm.port !== entry.port) return false;
  const started = processStartSeconds(entry.pid);
  return started !== null && Math.abs(started - pm.startedAt) <= 5;
}
function onPath(bin) {
  return spawnSync(isWin ? "where" : "which", [bin], { stdio: "ignore" }).status === 0;
}
async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    return res.status < 500;
  } catch {
    return false;
  }
}
function tail(file, lines = 25) {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}
async function waitFor(label, check, { timeoutMs = 45000, pid, logFile } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    checkInterrupted();
    if (await check()) return;
    checkInterrupted();
    if (pid && !alive(pid)) fail(`${label} exited during startup. Last log lines:\n${tail(logFile)}`);
    await sleep(500);
  }
  fail(`${label} not ready after ${timeoutMs / 1000}s. Last log lines:\n${tail(logFile)}`);
}
async function waitForExit(pid, timeoutMs) {
  const started = Date.now();
  while (alive(pid) && Date.now() - started < timeoutMs) await sleep(100);
  return !alive(pid);
}
/** Starts a detached process; resolves once it has spawned, fails (not crashes) on spawn errors. */
async function startDetached(name, bin, args, { cwd = root, env = {} } = {}) {
  checkInterrupted();
  mkdirSync(stateDir, { recursive: true });
  const logFile = path.join(stateDir, `${name}.log`);
  const fd = openSync(logFile, "a");
  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(new StackError(`could not start ${name} (${bin}): ${error.message}`)));
  });
  child.unref();
  return { pid: child.pid, logFile };
}
function signalTree(pid, signal) {
  try {
    process.kill(-pid, signal); // detached => its own process group
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Stops one service if (and only if) it is verifiably ours, and forgets it only once
 * it has exited. `startedByThisRun` (in memory, never persisted) relaxes the checks to
 * alive + image for a process this invocation just spawned and that may not listen yet.
 * Throws (keeping the entry) if the process won't exit.
 */
async function stopService(name, state, { quiet = false, startedByThisRun = false } = {}) {
  const entry = state[name];
  if (!entry) return;
  const ours =
    (await isOurs(name, entry)) ||
    (startedByThisRun && alive(entry.pid) && imageOf(entry.pid) === IMAGE[name]);
  if (!ours) {
    if (alive(entry.pid) && !quiet) log(`${name}: pid ${entry.pid} is no longer ours (stale state); not touching it`);
    delete state[name];
    return;
  }
  if (name === "pg") spawnSync("pg_ctl", ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "10"], { stdio: "ignore" });
  if (alive(entry.pid)) {
    if (isWin) {
      spawnSync("taskkill", ["/PID", String(entry.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      // POSIX: ask nicely first, then force, so a hung graceful shutdown can't block `down`.
      signalTree(entry.pid, "SIGTERM");
      if (!(await waitForExit(entry.pid, 5000))) signalTree(entry.pid, "SIGKILL");
    }
  }
  if (!(await waitForExit(entry.pid, 5000))) {
    writeState(state); // keep the entry so a later `down` can retry
    fail(`${name}: pid ${entry.pid} did not exit; stop it manually, then run down again`);
  }
  delete state[name];
  if (!quiet) log(`stopped ${name === "pg" ? "postgres" : name}`);
}

/** Tries to stop every named service; throws one error listing all that failed. */
async function stopAll(names, state, options) {
  const failures = [];
  const stopped = [];
  for (const name of names) {
    try {
      const had = Boolean(state[name]);
      await stopService(name, state, options);
      if (had) stopped.push(name);
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (existsSync(stateDir)) writeState(state);
  if (failures.length) fail(`could not stop everything:\n  ${failures.join("\n  ")}`);
  return stopped;
}

// ------------------------------------------------------------ commands ----
async function up() {
  if (has("fresh")) await down({ quiet: true, dropData: true });
  const state = readState();
  for (const name of ["pg", "api", "web"]) {
    if (state[name] && !(await isOurs(name, state[name]))) delete state[name]; // stale entry
  }
  const startedNow = [];
  const summary = [];
  const record = (name, entry) => {
    state[name] = entry;
    startedNow.push(name);
    writeState(state);
    checkInterrupted(); // recorded first, so cleanup still stops it
  };

  // First signal: stop starting things; the catch below cleans up, then we exit.
  // Second signal: exit now and say what may still be running.
  const signalCodes = os.constants.signals;
  const onSignal = (signal) => {
    if (interrupted) {
      process.stderr.write(`stack: second ${signal}; exiting without cleanup. May still be running: ${startedNow.join(", ") || "nothing"} (run: node scripts/stack.mjs down)\n`);
      process.exit(128 + signalCodes[signal]);
    }
    interrupted = signal;
    process.stderr.write(`stack: ${signal} received; stopping what this run started (press again to exit immediately)\n`);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    // Database
    let databaseUrl = process.env.DATABASE_URL;
    const external = Boolean(databaseUrl);
    if (!external && hasDbPackage && !has("no-db")) {
      if (state.pg) {
        log(`postgres already running (pid ${state.pg.pid})`);
      } else {
        for (const bin of ["initdb", "postgres", "pg_isready", "createdb", "pg_ctl"]) {
          if (!onPath(bin)) fail(`${bin} not on PATH. Install PostgreSQL, or set DATABASE_URL to an existing database.`);
        }
        if (await portInUse(ports.pg)) fail(`port ${ports.pg} is already in use (set STACK_PG_PORT)`);
        if (!existsSync(dataDir)) {
          const init = spawnSync("initdb", ["-D", dataDir, "-U", "aure", "--auth=trust", "-E", "UTF8"], { encoding: "utf8" });
          if (init.status !== 0) fail(`initdb failed:\n${init.stderr}`);
          log("created throwaway cluster in .stack/pgdata");
        }
        const pg = await startDetached("postgres", "postgres", ["-D", dataDir, "-p", String(ports.pg), "-c", "listen_addresses=localhost"]);
        record("pg", { pid: pg.pid, port: ports.pg, logFile: pg.logFile });
        await waitFor(
          "postgres",
          () => spawnSync("pg_isready", ["-h", "localhost", "-p", String(ports.pg), "-q"]).status === 0,
          pg,
        );
        log(`postgres ready on ${ports.pg}`);
      }
      checkInterrupted();
      const port = String(state.pg.port);
      const created = spawnSync("createdb", ["-h", "localhost", "-p", port, "-U", "aure", "aure"], { encoding: "utf8" });
      if (created.status !== 0 && !/already exists/.test(created.stderr)) fail(`createdb failed:\n${created.stderr}`);
      databaseUrl = `postgres://aure@localhost:${port}/aure`;
    }
    if (hasDbPackage && databaseUrl && (!external || has("migrate"))) {
      checkInterrupted();
      const migrate = spawnSync(process.execPath, ["migrate.mjs"], {
        cwd: path.join(root, "packages/db"),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        encoding: "utf8",
      });
      if (migrate.status !== 0) fail(`migrations failed:\n${migrate.stdout}${migrate.stderr}`);
      const applied = migrate.stdout.trim();
      log(applied ? applied.replace(/^/gm, "migrate: ") : "migrations up to date");
    } else if (external && hasDbPackage) {
      log("DATABASE_URL is external: skipped migrations (pass --migrate to run them)");
    }
    if (databaseUrl) summary.push(`DATABASE_URL=${databaseUrl}`);

    // API
    const apiUrl = `http://localhost:${ports.api}`;
    if (!has("no-api")) {
      if (state.api) {
        log(`api already running (pid ${state.api.pid})`);
      } else {
        const main = path.join(root, "apps/api/dist/main.js");
        if (!existsSync(main)) fail("apps/api is not built. Run: pnpm turbo run build");
        if (await portInUse(ports.api)) fail(`port ${ports.api} is already in use (set STACK_API_PORT)`);
        const api = await startDetached("api", process.execPath, ["dist/main.js"], {
          cwd: path.join(root, "apps/api"),
          // The pool is lazy, so a dummy URL is enough when there is no database yet.
          env: { PORT: String(ports.api), DATABASE_URL: databaseUrl ?? "postgres://unused@localhost:1/unused" },
        });
        record("api", { pid: api.pid, port: ports.api, logFile: api.logFile });
        await waitFor("api", () => httpOk(`${apiUrl}/api/health`), api);
        log(`api ready on ${apiUrl}`);
      }
      summary.push(`API_URL=${apiUrl}`);
    }

    // Web
    if (!has("no-web")) {
      const webUrl = `http://localhost:${ports.web}`;
      if (state.web) {
        log(`web already running (pid ${state.web.pid})`);
      } else {
        const server = path.join(root, "apps/web/.output/server/index.mjs");
        if (!existsSync(server)) fail("apps/web is not built. Run: pnpm turbo run build");
        if (await portInUse(ports.web)) fail(`port ${ports.web} is already in use (set STACK_WEB_PORT)`);
        const web = await startDetached("web", process.execPath, [".output/server/index.mjs"], {
          cwd: path.join(root, "apps/web"),
          env: { PORT: String(ports.web), API_URL: apiUrl },
        });
        record("web", { pid: web.pid, port: ports.web, logFile: web.logFile });
        await waitFor("web", () => httpOk(`${webUrl}/`), web);
        log(`web ready on ${webUrl}`);
      }
      summary.push(`WEB_URL=${webUrl}`);
    }
    checkInterrupted();
  } catch (error) {
    // Single cleanup path for failures and signals. Stop what this run started, newest
    // first; stopAll tries every service even if one refuses to stop.
    let cleanupError;
    try {
      const stopped = await stopAll([...startedNow].reverse(), state, { quiet: true, startedByThisRun: true });
      if (stopped.length) log(`stopped ${stopped.join(", ")} after the ${interrupted ? "interrupt" : "failure"}`);
    } catch (stopError) {
      cleanupError = stopError;
    }
    if (interrupted) {
      if (cleanupError) process.stderr.write(`stack: ${cleanupError.message}\n`);
      process.exit(128 + os.constants.signals[interrupted]);
    }
    if (cleanupError) process.stderr.write(`stack: ${cleanupError.message}\n`);
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  writeState(state);
  log(`up\n  ${summary.join("\n  ")}\n  logs: .stack/*.log   stop: node scripts/stack.mjs down`);
}

async function down({ clean = has("clean"), quiet = false, dropData = false } = {}) {
  const state = readState();
  // Tries all services; throws before any data removal if one is still running.
  await stopAll(["web", "api", "pg"], state, { quiet });
  if (clean) {
    rmSync(stateDir, RM_RETRIES);
    if (!quiet) log("removed .stack/");
    return;
  }
  if (dropData) rmSync(dataDir, RM_RETRIES);
}

async function status() {
  const state = readState();
  const services = [];
  for (const name of ["pg", "api", "web"]) {
    services.push({
      name,
      running: await isOurs(name, state[name]),
      // What a complete stack needs: Postgres only when there is a db package and no external DATABASE_URL.
      required: name !== "pg" || (hasDbPackage && !process.env.DATABASE_URL),
      port: state[name]?.port ?? ports[name],
      pid: state[name]?.pid ?? null,
    });
  }
  const needed = services.filter((s) => s.required);
  const report = {
    services,
    ready: needed.every((s) => s.running),
    partial: needed.some((s) => s.running) && !needed.every((s) => s.running),
  };
  if (has("json")) {
    process.stdout.write(JSON.stringify(report) + "\n");
    return;
  }
  for (const s of services) {
    log(`${s.name.padEnd(3)} ${s.running ? `running  pid ${s.pid}  port ${s.port}` : s.required ? "stopped" : "not needed"}`);
  }
}

try {
  if (command === "up") await up();
  else if (command === "down") await down();
  else if (command === "status") await status();
  else fail("usage: node scripts/stack.mjs up [--fresh] [--no-db] [--no-api] [--no-web] [--migrate] | down [--clean] | status [--json]");
} catch (error) {
  if (!(error instanceof StackError)) throw error;
  process.stderr.write(`stack: ${error.message}\n`);
  process.exitCode = 1;
}
