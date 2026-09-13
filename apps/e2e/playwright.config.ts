import { defineConfig, devices } from "@playwright/test";

/** Where the stack runs. Defaults match scripts/stack.mjs; empty strings count as unset. */
export const API_URL = process.env.E2E_API_URL || "http://localhost:3457";
export const WEB_URL = process.env.E2E_WEB_URL || "http://localhost:3100";

// Local runs can use an installed browser (PLAYWRIGHT_CHANNEL=chrome or msedge)
// instead of downloading Playwright's Chromium. CI installs Chromium.
const channel = process.env.PLAYWRIGHT_CHANNEL;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: isCI,
  // CI retries exist to capture traces of intermittent failures, not to pass them:
  // a test that only passes on retry is reported as flaky and fails the job.
  retries: isCI ? 2 : 0,
  failOnFlakyTests: isCI,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  // Starts the whole stack (fresh database) unless a complete one is already running
  // or both E2E_API_URL and E2E_WEB_URL point somewhere else. See global-setup.ts.
  globalSetup: "./global-setup.ts",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "api",
      testMatch: "api/**/*.spec.ts",
      use: { baseURL: API_URL },
    },
    {
      name: "web",
      testMatch: "web/**/*.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: WEB_URL, ...(channel ? { channel } : {}) },
    },
  ],
});
