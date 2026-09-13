import { expect, gotoHydrated, test } from "./fixtures";

test.describe("home page", () => {
  test("renders and hydrates without console errors", async ({ page }) => {
    const response = await gotoHydrated(page, "/");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle("aure");
    await expect(page.getByRole("heading", { level: 1, name: "aure" })).toBeVisible();
  });
});
