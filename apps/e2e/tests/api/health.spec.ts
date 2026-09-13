import { expect, test } from "@playwright/test";

test.describe("health API", () => {
  // Infrastructure endpoint with no @aure/contracts schema, so the body is checked exactly.
  test("reports the service as ok", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
