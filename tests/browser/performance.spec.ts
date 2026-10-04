import { test, expect, type Page } from "@playwright/test";
import { encode, type SharedState } from "../../playground/share.ts";

// Repeated snapshots of roughly 80,000 DOM nodes dominate the measured interactions on CI.
// Keep action traces and failure screenshots without copying the entire drawing at every step.
test.use({ trace: { mode: "retain-on-failure", snapshots: false, screenshots: false, sources: true } });

function schema(n: number, hub = false): string {
  return Array.from({ length: n }, (_, i) => `table t${i} {\n id bigint pk\n${Array.from({ length: Math.min(i, hub ? 1 : 3) }, (_, r) => ` ref_${r} bigint -> t${hub ? 0 : i - r - 1}.id index`).join("\n")}\n${Array.from({ length: 23 - Math.min(i, hub ? 1 : 3) }, (_, c) => ` value_${c} varchar(100)`).join("\n")}\n}`).join("\n");
}
const shared = (code: string): SharedState => ({ code, columns: "all", audit: "collapse", edges: "angular", related: null });
async function ready(page: Page, n: number): Promise<void> {
  await expect(page.locator("#content .rz-t")).toHaveCount(n, { timeout: 15_000 });
  await expect(page.locator("#layout-status")).toBeHidden();
  await expect(page.locator("#save-status")).toHaveText("Saved locally");
}
async function append(page: Page, text: string): Promise<void> {
  const oldHash = await page.evaluate(() => location.hash);
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(text);
  await expect.poll(() => page.evaluate(() => location.hash)).not.toBe(oldHash);
  await expect(page.locator("#layout-status")).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
  await page.addInitScript(() => {
    let layouts = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
      if ((message as { cmd?: string })?.cmd === "layout") document.documentElement.dataset.layouts = String(++layouts);
      return Reflect.apply(post, this, [message, ...rest]);
    } as typeof post;
  });
});

test("keeps mounted content for comment edits and live background changes", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Full-column load budgets run on Chromium; workflow tests cover every engine");
  test.setTimeout(45_000);
  await page.goto(`/playground/${await encode(shared(schema(500)))}`);
  await ready(page, 500);
  await page.locator("#content svg").evaluate(svg => svg.setAttribute("data-preserved", "true"));
  const layouts = await page.locator("html").getAttribute("data-layouts");
  await append(page, "\n%% A comment changes source positions only");
  await expect(page.locator("#content svg")).toHaveAttribute("data-preserved", "true");
  // Static fallback embeds the stage in SVG and must redraw it when the theme changes.
  if (await page.locator("canvas.stage-glass").count()) {
    await page.locator('[data-stage="silk"]').click();
    await expect(page.locator('[data-stage="silk"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#layout-status")).toBeHidden();
    await expect(page.locator("#content svg")).toHaveAttribute("data-preserved", "true");
  }
  await expect(page.locator("html")).toHaveAttribute("data-layouts", layouts!);
  await append(page, "\ntable newly_added { id int pk }\n");
  await ready(page, 501);
  await expect(page.locator('#content .rz-t[data-t="newly_added"]')).toHaveCount(1);
});

test("reuses earlier All and related layouts after switching views", async ({ page }) => {
  await page.goto(`/playground/${await encode(shared(schema(40)))}`);
  await ready(page, 40);
  await page.locator("#content svg").evaluate(svg => svg.setAttribute("data-restored", "true"));
  await page.locator('[data-columns="none"]').click();
  await expect(page.locator("#content .rz-c")).toHaveCount(0);
  const layouts = await page.locator("html").getAttribute("data-layouts");
  await page.locator('[data-columns="all"]').click();
  await expect(page.locator("#content .rz-c")).toHaveCount(40 * 24);
  await expect(page.locator("#content svg")).toHaveAttribute("data-restored", "true");
  await expect(page.locator("html")).toHaveAttribute("data-layouts", layouts!);
});

test("lays out a 500-table hub with all columns within the load budget", async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "Load budgets run on Chromium");
  test.setTimeout(30_000);
  const start = Date.now();
  await page.goto(`/playground/${await encode(shared(schema(500, true)))}`);
  await ready(page, 500);
  const elapsed = Date.now() - start;
  await info.attach("hub-load-ms", { body: String(elapsed), contentType: "text/plain" });
  expect(elapsed).toBeLessThan(15_000);
  await expect(page.locator("#content .rz-r")).toHaveCount(499);
  await page.locator("#find").click(); await page.locator("#palette-input").fill("t0"); await page.locator("#palette-input").press("Enter");
  await page.locator('#inspector-body tr[data-c="id"] button').first().click();
  await expect(page.locator("#content .rz-r.is-on")).toHaveCount(499);
});

test("keeps animated pan, zoom, and composite focus aligned", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Animation smoke coverage runs on Chromium");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const code = 'table accounts {\n tenant_id int pk\n id int pk\n}\ntable orders {\n id int pk\n tenant_id int\n account_id int\n foreign(tenant_id, account_id) -> accounts(tenant_id, id)\n index(tenant_id, account_id)\n}';
  await page.goto(`/playground/${await encode(shared(code))}`);
  await ready(page, 2);
  await page.locator('.rz-t[data-t="orders"] .rz-head').click();
  await page.locator('#inspector-body tr[data-c="account_id"] button').click();
  await expect(page.locator('#content .rz-t[data-t="accounts"] .rz-c.is-on')).toHaveCount(2);
  await expect(page.locator('#content .rz-t[data-t="orders"] .rz-c.is-on')).toHaveCount(2);
  await page.locator("#zoom-in").click();
  await expect(page.locator("#pop")).toBeVisible();
  await page.locator("#zoom-fit").click();
  await expect(page.locator("#content .rz-r.is-on")).toHaveCount(2);
});
