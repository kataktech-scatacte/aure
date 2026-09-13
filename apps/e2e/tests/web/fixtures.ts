import { expect, type Page, type Response, test as base } from "@playwright/test";

interface WebFixtures {
  /** Console messages that are expected in this test, e.g. the 404 status of a not-found page. */
  allowedConsoleErrors: RegExp[];
  consoleErrors: string[];
}

/**
 * Web tests import `test` from here, not from @playwright/test: every test fails
 * if the page logs a console error or throws, which is how hydration mismatches
 * and client crashes surface.
 */
export const test = base.extend<WebFixtures>({
  allowedConsoleErrors: [[], { option: true }],
  consoleErrors: [
    async ({ page, allowedConsoleErrors }, use) => {
      const errors: string[] = [];
      const record = (text: string): void => {
        if (!allowedConsoleErrors.some((pattern) => pattern.test(text))) errors.push(text);
      };
      page.on("console", (message) => {
        if (message.type() === "error") record(message.text());
      });
      page.on("pageerror", (error) => record(error.message));
      await use(errors);
      expect(errors, "browser console errors").toEqual([]);
    },
    { auto: true },
  ],
});

/**
 * Navigates and waits until React has hydrated the server-rendered page.
 * Interacting earlier hits plain HTML: a form would do a native submit and a
 * click would do nothing. TanStack Start removes `window.$_TSR` once the page is
 * hydrated and its SSR stream has finished.
 */
export async function gotoHydrated(page: Page, url: string): Promise<Response | null> {
  const response = await page.goto(url);
  await page.waitForFunction(() => !("$_TSR" in window));
  return response;
}

export { expect };
