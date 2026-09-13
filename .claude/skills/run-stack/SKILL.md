---
name: run-stack
description: Start, inspect and stop the whole aure app locally for verification and e2e tests. Covers a throwaway Postgres cluster, migrations, the built NestJS API and the built TanStack Start web app, all via scripts/stack.mjs, plus seeding data through the API, reading logs, and driving the running app from curl and the browser tools. Use this whenever you need the app actually running: verifying a feature end to end, reproducing a bug, running Playwright tests against a live stack, or checking server-rendered pages and API responses. Also use it when a port is busy, a server won't start, or the stack was left running.
---

# Run the stack

`scripts/stack.mjs` owns the lifecycle, so nobody hand-starts servers:

```
throwaway Postgres (.stack/pgdata, port 55432) -> migrations -> API :3457 -> web :3100
```

Its processes start **detached**, so they outlive the shell that started them. Always finish with `down`, even after a failure.

## Commands

Run from the repo root:

```bash
pnpm turbo run build --force               # the stack runs BUILT apps: rebuild after code changes
node scripts/stack.mjs up --fresh          # new empty database, migrate, start api + web
node scripts/stack.mjs status              # what's running (add --json for scripts)
node scripts/stack.mjs down                # stop everything, keep .stack/pgdata
node scripts/stack.mjs down --clean        # stop and delete .stack/ entirely
```

`up` options:
- `--fresh`: stop anything running and recreate the database. Use it for verification, so results never depend on leftover data.
- `--no-web` / `--no-api` / `--no-db`: start only what the check needs. Without a `packages/db` package, Postgres is skipped automatically.
- `--migrate`: required to run migrations when `DATABASE_URL` points at an existing database. Never migrate a shared database without being asked.

Environment:
- `STACK_PG_PORT`, `STACK_API_PORT`, `STACK_WEB_PORT` override the ports.
- `DATABASE_URL` uses an existing database instead of a throwaway cluster.
- Wired up for you: the API gets `PORT` and `DATABASE_URL`; the web app gets `PORT` and `API_URL`, pointing at the stack's API.

`up` is idempotent and safe:
- **Reuse:** it reuses services that are verifiably still running, never trusting the PID alone. api/web must be this Node binary and hold their port. Postgres must be a postgres process holding its port whose PID, port and start time all match `.stack/pgdata/postmaster.pid`.
- **Stale state:** entries left in `.stack/state.json` after a crash or reboot are discarded. Their PIDs are never killed, even if another process now holds them.
- **Readiness:** it waits on `pg_isready`, `GET /api/health` and `GET /`. If a service dies or never becomes ready, it prints the tail of `.stack/<service>.log`.
- **Failure cleanup:** a failed `up` stops everything that invocation started, then exits 1.
- **Interrupts:** Ctrl+C or SIGTERM during `up` stops starting new services, stops the ones it started, and exits 128 + signal (130 for Ctrl+C, 143 for SIGTERM). A second Ctrl+C exits immediately and names what may still be running; run `down` afterwards.
- **Stopping:** `down` tries every service, even if one fails. On Linux/macOS it escalates from SIGTERM to SIGKILL after 5s; on Windows it force-kills the process tree. If a process still won't exit, its entry is kept, no data is deleted, and `down` exits 1 listing what's stuck.

`down` waits for each process to exit before returning, and `status --json` reports `{ services, ready, partial }`. Postgres counts as required only when `packages/db` exists and `DATABASE_URL` isn't set.

**Prerequisites:**
- Built apps.
- Node `^22.22.3 || ^24.15.0 || >=26` for installs.
- `initdb`/`postgres`/`pg_isready`/`createdb` on PATH for the throwaway database. Otherwise set `DATABASE_URL`, or verify only what works without a database.

## Seeding data

Seed through the API, never with SQL. That exercises the same validation real users hit, and it keeps working when tables change:

```bash
curl -s -X POST http://localhost:3457/api/orders -H 'content-type: application/json' \
  -d '{"title":"Seed order","quantity":1,"priceCents":100,"paid":false}'
```

Create what a check needs, including more than one page's worth when pagination matters. Use unique values so parallel checks don't collide.

## Checking the running app

**API:** use `curl -s -w '\n[%{http_code}]'` so every response shows its status. Check success codes and the failure contract:
- 400 with `{ message, issues: [{ path, message }] }` for bad input
- 404 for unknown ids
- 409 for conflicts

**Server-rendered pages:** `curl -s http://localhost:3100/<path>` should contain the content and `<title>` without JavaScript. `curl -s -o /dev/null -w '%{http_code} %{redirect_url}'` reveals unexpected redirects.

**Browser (in-app browser tools):**
- Load pages with `navigate`, read structure with `read_page` (it shows labels and roles), and check `read_console_messages` after every page. Hydration mismatches and client errors show up there. A not-found page's own 404 is expected.
- If `computer` clicks time out because the pane isn't on screen, drive the page with `javascript_tool` instead:
  - `element.click()` for buttons and checkboxes (`form_input` doesn't toggle React-controlled checkboxes)
  - for React-controlled text inputs, set the value with the native setter, then fire an `input` event:
    `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }))`
  - `form.requestSubmit()` to submit
- Wait for hydration before interacting: TanStack Start deletes `window.$_TSR` once hydrated. Before that, forms submit natively and clicks do nothing.
- Check a narrow viewport with `resize_window` (preset `mobile`), and reset it with preset `desktop` afterwards.

**Logs:** `.stack/api.log`, `.stack/web.log` and `.stack/postgres.log` show server errors behind a 500 or a blank page.

## Troubleshooting

- **"port N is already in use"**: run `node scripts/stack.mjs status`. If the stack isn't holding the port, something else is (a dev server, another run). Stop it, or use `STACK_*_PORT`. Don't kill processes you didn't start.
- **"apps/api is not built" / stale behavior**: rebuild. The stack never runs dev servers or source.
- **Stack state looks wrong** (a crashed run): `status` already ignores stale entries. `node scripts/stack.mjs down --clean`, then `up --fresh`, resets everything.
- **A reused stack runs an old build:** Playwright's setup reuses a running stack. After changing app code, rebuild and `down` first.
- **A piped command never finishes** (Windows): a stack service was started from inside another tool's process, e.g. Playwright's setup, and inherited that tool's output pipe. Running `node scripts/stack.mjs up` directly is safe even when piped, and e2e setup only starts services it also stops. If it happens anyway, `node scripts/stack.mjs down` releases the pipe.
- **Windows:** keep the repo at a short path. Tools fail in odd ways (`spawn ... ENOENT`, `ERR_PACKAGE_IMPORT_NOT_DEFINED`) once `node_modules` paths pass about 260 characters. Never wrap `pg_ctl start` in a pipe; the script already handles detaching.
- **`pnpm install` fails with `ERR_PNPM_UNSUPPORTED_ENGINE`**: the Node version is too old. Report it; don't bypass `engineStrict`.
