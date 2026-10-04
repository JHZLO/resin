import { expect, test, type Page } from "@playwright/test";
import { encode, type SharedState } from "../../playground/share.ts";

const source = "table users {\n id bigint pk\n}\ntable orders {\n id bigint pk\n user_id bigint\n}";
const state: SharedState = { code: source, columns: "all", audit: "collapse", edges: "angular", related: null };
async function open(page: Page) {
  await page.goto(`/playground/${await encode(state)}`);
  await expect(page.locator("#content .rz-t")).toHaveCount(2);
}
async function workspace(page: Page, tab: string) {
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page.getByRole("tab", { name: tab, exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
});

test("keeps named documents across examples and reloads without undoing into an example", async ({ page }) => {
  await open(page); await workspace(page, "Documents");
  await page.getByLabel("Document name", { exact: true }).fill("Billing");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("dialog", { name: "Schema workspace" }).getByRole("button", { name: "Close", exact: true }).click();
  await page.locator("#example").selectOption("shop");
  await expect(page.locator("#document-name")).toHaveText("shop.erd");
  await workspace(page, "Documents");
  await page.locator(".workspace-list .workspace-actions").filter({ hasText: "Billing" }).getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator("#content .rz-t")).toHaveCount(2);
  await expect(page.locator("#document-name")).toHaveText("Billing");
  await page.reload();
  await expect(page.locator("#content .rz-t")).toHaveCount(2);
  await page.locator(".cm-content").click(); await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".cm-content")).toContainText("user_id bigint");
  await expect(page.locator(".cm-content")).not.toContainText("coupons");
});

test("reviews skipped SQL, adds a logical relation, and preserves its service on update", async ({ page }) => {
  await open(page); await workspace(page, "Import");
  const sql = "CREATE TABLE users (id bigint PRIMARY KEY);\nCREATE TABLE orders (id bigint PRIMARY KEY, user_id bigint);\nCREATE TABLE skipped AS SELECT * FROM users;";
  await page.getByLabel("SQL source", { exact: true }).fill(sql);
  await page.getByLabel("Service for this import (optional)", { exact: true }).fill("billing");
  await page.getByRole("button", { name: "Preview import", exact: true }).click();
  await expect(page.getByText(/SQL 3:1 - skipped table/)).toBeVisible();
  await page.getByRole("button", { name: "Apply import", exact: true }).click();
  await expect(page.locator('[data-t="billing.orders"]')).toBeVisible();
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.getByRole("checkbox", { name: /billing.orders.user_id/ }).check();
  await page.getByRole("button", { name: "Add selected relations", exact: true }).click();
  await page.getByRole("tab", { name: "Import", exact: true }).click();
  await expect(page.getByLabel("Service for this import (optional)")).toHaveValue("billing");
  await page.getByLabel("SQL source", { exact: true }).fill(sql.replace("user_id bigint)", "user_id bigint, total int)"));
  await page.getByRole("button", { name: "Preview import", exact: true }).click();
  await expect(page.getByLabel("Resin preview (editable)")).toHaveValue(/~> billing\.users\.id/);
  await page.getByRole("button", { name: "Apply import", exact: true }).click();
  await expect(page.locator('[data-t="billing.orders"] [data-c="total"]')).toBeVisible();
  await expect(page.locator("#content .rz-r")).toHaveCount(1);
});

test("reports storage failure and keeps source export available", async ({ page }) => {
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException("full", "QuotaExceededError"); }; });
  await open(page);
  await expect(page.locator("#save-error")).toContainText("Download the .erd file");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: ".erd", exact: true }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.erd$/);
});

test("shares a reading view and makes an independent editable copy", async ({ page }) => {
  await page.goto(`/playground/${await encode({ ...state, reading: true })}`);
  await expect(page.locator("#content .rz-t")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Edit a copy", exact: true })).toBeVisible();
  await expect(page.locator("#source")).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Edit a copy", exact: true }).click();
  await expect(page.locator("#source")).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Documents", exact: true })).toBeVisible();
});

test("keeps workspace controls within a 375px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page); await workspace(page, "Documents");
  const box = await page.getByRole("dialog", { name: "Schema workspace" }).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  await page.getByLabel("Document name", { exact: true }).fill("Mobile document");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByLabel("Document name", { exact: true })).toHaveValue("Mobile document");
});

test("saves and restores a relationship view without replacing source", async ({ page }) => {
  await open(page); await workspace(page, "Explore");
  await page.getByRole("checkbox", { name: /orders.user_id/ }).check();
  await page.getByRole("button", { name: "Add selected relations", exact: true }).click();
  await page.getByLabel("Table", { exact: true }).selectOption("orders");
  await page.getByLabel("Reference direction", { exact: true }).selectOption("outgoing");
  await page.getByRole("button", { name: "Show related", exact: true }).click();
  await expect(page.locator("#view-summary")).toContainText("outgoing");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.getByLabel("View name", { exact: true }).fill("Orders and parents");
  await page.getByRole("button", { name: "Save current view", exact: true }).click();
  await page.getByRole("dialog", { name: "Schema workspace" }).getByRole("button", { name: "Show all", exact: true }).click();
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.getByRole("button", { name: "Load view", exact: true }).click();
  await expect(page.locator("#view-summary")).toContainText("outgoing");
  await expect(page.locator(".cm-content")).toContainText("~> users.id");
});
