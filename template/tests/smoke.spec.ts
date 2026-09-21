import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

/**
 * The deployment manifest is the source of truth for the app's name; the page's
 * <h1> has to agree with it, so this catches a renamed app with a stale manifest
 * (or the other way round).
 */
const appName = async (): Promise<string> => {
  const manifest: unknown = JSON.parse(await readFile("pyre.manifest.json", "utf8"));
  const name = manifest !== null && typeof manifest === "object" && "name" in manifest ? manifest.name : null;
  if (typeof name !== "string" || name === "") throw new Error("pyre.manifest.json has no name");
  return name;
};

test("the home page shows the app heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(await appName());
});

test("the hello function returns a result", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your name").fill("Pyre");
  await page.getByRole("button", { name: "Run hello" }).click();

  const result = page.getByTestId("hello-result");
  await expect(result).toBeVisible();
  await expect(result).toContainText("Hello, Pyre!");
  await expect(result).toContainText(/called \d+ time/);
});
