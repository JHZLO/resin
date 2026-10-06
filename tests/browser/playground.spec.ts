import { expect, test, type Page } from "@playwright/test";
import { encode, type SharedState } from "../../playground/share.ts";
import { readFileSync } from "node:fs";
import { compile } from "../../src/index.ts";

let pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Fonts are not part of the application contract and should not make offline QA flaky.
  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
});
test.afterEach(() => expect(pageErrors).toEqual([]));

const schema = `table users "People" {
  id int pk
  name varchar
}
table orders {
  id int pk
  user_id int -> users index
}
table lines {
  id int pk
  order_id int -> orders index
}
table unrelated {
  id int pk
}`;

const shared = (code = schema, overrides: Partial<SharedState> = {}): SharedState => ({
  code, columns: "all", audit: "collapse", edges: "angular", related: null, base: null, ...overrides,
});
async function open(page: Page, overrides: Partial<SharedState> = {}) {
  await page.goto(`/playground/${await encode(shared(schema, overrides))}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#content .rz-t")).toHaveCount(4);
}

test("applies a link whose document is unchanged but whose view changed", async ({ page }) => {
  await open(page);
  const hash = await encode(shared(schema, { columns: "none", related: { table: "users", steps: 1 } }));
  await page.evaluate((next) => { location.hash = next; }, hash);
  await expect(page.locator('[data-columns="none"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#content .rz-t")).toHaveCount(2);
});

test("compares a new document against an empty base", async ({ page }) => {
  await open(page, { base: "" });
  await expect(page.locator("#compare-bar")).toBeVisible();
  await expect(page.locator("#compare-text")).toContainText("4 tables added");
  await page.locator("#compare-stop").click();
  await expect(page.locator("#compare-bar")).toBeHidden();
});

test("recovers from valid JSON with invalid saved document fields", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("resin.playground", '{"code":42,"columns":"invalid"}'));
  await page.goto("/playground/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#content .rz-t").first()).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("table");
});

async function edit(page: Page, text: string) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+A");
  if (text) await page.keyboard.insertText(text);
  else await page.keyboard.press("Backspace");
}

async function paste(page: Page, text: string) {
  await page.locator(".cm-content").focus();
  await page.locator(".cm-content").evaluate((editor, source) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", source);
    const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
    // Firefox strips data from synthetic clipboard events; keep this DOM-event test deterministic.
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    editor.dispatchEvent(event);
  }, text);
}

for (const dialect of ["mysql", "postgres", "sqlite", "sqlserver", "oracle"]) {
  test(`pastes the ${dialect} DDL fixture and restores the raw SQL with Undo`, async ({ page }) => {
    const sql = readFileSync(new URL(`../../examples/sql/${dialect}.sql`, import.meta.url), "utf8");
    const expected = compile(readFileSync(new URL(`../../examples/sql/${dialect}.erd`, import.meta.url), "utf8")).model!;
    await page.goto(`/playground/${await encode(shared(""))}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#empty")).toBeVisible();
    await paste(page, sql);
    await expect(page.locator("#sql-text")).toContainText("Converted");
    await expect(page.locator("#content .rz-t")).toHaveCount(expected.tables.filter((t) => t.origin !== "audit").length);
    await expect(page.locator("#problem-count")).not.toHaveAttribute("data-state", "error");
    await page.locator("#sql-undo").click();
    await expect(page.locator(".cm-content")).toContainText("CREATE");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator("#empty")).toBeVisible();
  });
}

test("appends SQL without losing existing work and shows conversion notes", async ({ page }) => {
  await open(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await paste(page, "CREATE TABLE notes (id INT PRIMARY KEY, user_id INT REFERENCES users(id), label TEXT); CREATE INDEX ix_label ON notes (lower(label));");
  await expect(page.locator("#content .rz-t")).toHaveCount(5);
  await expect(page.locator("#sql-notes")).toContainText("1 note");
  await expect(page.locator(".cm-content")).toContainText("Not converted");
  await page.locator("#sql-undo").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("#content .rz-t")).toHaveCount(4);
});

test("recovers from syntax errors and clears an empty diagram", async ({ page }) => {
  await open(page);
  await edit(page, "table broken { id");
  await expect(page.locator("#stale")).toBeVisible();
  await expect(page.locator("#content .rz-t")).toHaveCount(4);
  await edit(page, "table fixed { id int pk }");
  await expect(page.locator('#content .rz-t[data-t="fixed"]')).toBeVisible();
  await expect(page.locator("#stale")).toBeHidden();
  await edit(page, "");
  await expect(page.locator("#content .rz-t")).toHaveCount(0);
  await expect(page.locator("#empty")).toBeVisible();
});

test("follows key references and switches the related neighborhood", async ({ page }) => {
  await open(page);
  await page.locator('.rz-t[data-t="users"] .rz-head').click();
  await page.locator("#inspector-related").click();
  await expect(page.locator("#content .rz-t")).toHaveCount(2);
  await page.locator('[data-steps="2"]').click();
  await expect(page.locator("#content .rz-t")).toHaveCount(3);
  await page.locator("#related-all").click();
  await expect(page.locator("#content .rz-t")).toHaveCount(4);
  await page.locator("#inspector-close").click();
  await page.locator('.rz-t[data-t="orders"] .rz-c[data-c="user_id"]').click();
  await expect(page.locator("#pop")).toBeVisible();
  await expect(page.locator("#content svg")).toHaveClass(/is-focus/);
  await expect(page.locator('#content .rz-t[data-t="unrelated"]')).not.toHaveClass(/is-on/);
  await expect(page.locator('#content .rz-t[data-t="users"]')).toHaveClass(/is-on/);
});

for (const table of ["users", "customer_accounts_with_a_very_long_service_qualified_table_name".repeat(3)]) {
  test(`keeps related controls separate and reachable with ${table === "users" ? "short" : "long"} names`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 850 });
    const code = schema.replaceAll("users", table);
    await page.goto(`/playground/${await encode(shared(code, { related: { table, steps: 1 }, reading: true }))}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#content .rz-t")).toHaveCount(2);

    for (const width of [1000, 1440, 375]) {
      await page.setViewportSize({ width, height: 850 });
      await expect.poll(() => page.evaluate(() => {
        const view = document.querySelector(".float.view")!.getBoundingClientRect();
        const related = document.querySelector("#related-pill")!.getBoundingClientRect();
        const viewport = document.querySelector("#viewport")!.getBoundingClientRect();
        const separate = related.top >= view.bottom + 4 || related.left >= view.right + 8;
        const contained = related.left >= viewport.left + 12 && related.right <= viewport.right - 12;
        const reachable = [...document.querySelectorAll("#related-pill button")].every(button => {
          const box = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        });
        return separate && contained && reachable;
      })).toBe(true);
      await page.locator('[data-steps="2"]').click();
      await expect(page.locator("#content .rz-t")).toHaveCount(3);
      await page.locator('[data-steps="1"]').click();
      await expect(page.locator("#content .rz-t")).toHaveCount(2);
    }

    await page.locator("#related-all").click();
    await expect(page.locator("#related-pill")).toBeHidden();
    await expect(page.locator("#content .rz-t")).toHaveCount(4);
  });
}

test("reveals a folded column selected from the table panel", async ({ page }) => {
  await open(page);
  await page.locator('.rz-t[data-t="users"] .rz-head').click();
  await page.locator('[data-columns="none"]').click();
  await page.locator('#inspector-body tr[data-c="name"] button').click();
  await expect(page.locator('[data-columns="all"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#pop")).toBeVisible();
});

test("retains a document after reload and ignores a damaged share link", async ({ page }) => {
  await open(page);
  await page.goto("/playground/#erd:broken", { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#content .rz-t")).toHaveCount(4);
  await expect(page.locator("#problem-count")).not.toHaveAttribute("data-state", "error");
});

test("downloads the current document even before the canvas catches up", async ({ page }) => {
  await open(page);
  await edit(page, "table exported { id int pk }");
  await page.locator("#download").click();
  const downloading = page.waitForEvent("download");
  await page.locator('[data-variant="plain"]').click();
  const download = await downloading;
  const text = readFileSync((await download.path())!, "utf8");
  expect(text).toContain('data-t="exported"');
  expect(text).not.toContain('data-t="users"');
});

test("renders a static diagram without WebGL and does not execute descriptions", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === "webgl" || type === "webgl2") return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  });
  const code = 'table safe "<img src=x onerror=alert(1)>" { id int pk }';
  await page.goto(`/playground/${await encode(shared(code))}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#content .rz-t")).toHaveCount(1);
  await page.locator(".rz-head").click();
  await expect(page.locator("#inspector")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("#content img, #inspector img")).toHaveCount(0);
});

test("keeps a narrow layout usable with the panel open", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === "webgl" || type === "webgl2") return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page);
  await page.locator("#find").click();
  await page.locator("#palette-input").fill("users");
  await page.locator("#palette-input").press("Enter");
  await expect(page.locator("#inspector")).toBeVisible();
  const bounds = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth,
    overflowing: [...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > innerWidth).map(el => ({ tag: el.tagName, id: el.id, right: el.getBoundingClientRect().right })).slice(0, 12) }));
  expect(bounds.width, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.viewport);
  for (const button of await page.locator(".bar-actions button:visible, #inspector-close").all()) {
    const box = await button.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds.viewport);
  }
  await page.locator("#inspector-close").click();
  await expect(page.locator("#find")).toBeVisible();
});

for (const size of [10, 100, 500]) {
  test(`fits and explores ${size} tables`, async ({ page }, info) => {
    test.skip(info.project.name !== "chromium", "The load profile is measured once; workflow compatibility runs on all engines");
    test.setTimeout(60_000);
    const code = Array.from({ length: size }, (_, i) => `table t${i} {\n id int pk\n${i ? ` previous_id int -> t${i - 1} index\n` : ""}}`).join("\n");
    const start = Date.now();
    await page.goto(`/playground/${await encode(shared(code, { columns: "none" }))}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#content .rz-t")).toHaveCount(size, { timeout: 45_000 });
    await info.attach("render-time", { body: `${size} tables: ${Date.now() - start} ms`, contentType: "text/plain" });
    const boxes = await page.locator("#content svg").boundingBox();
    const viewport = await page.locator("#viewport").boundingBox();
    expect(boxes!.width).toBeLessThanOrEqual(viewport!.width + 1);
    expect(boxes!.height).toBeLessThanOrEqual(viewport!.height + 1);
    await page.locator("#find").click();
    await page.locator("#palette-input").fill(`t${size - 1}`);
    await page.locator("#palette-input").press("Shift+Enter");
    await expect(page.locator("#content .rz-t")).toHaveCount(2);
  });
}

test("keeps a table panel open on a second header click", async ({ page }) => {
  await open(page);
  const header = page.locator('.rz-t[data-t="users"] .rz-head');
  await header.click();
  await expect(page.locator("#inspector")).toBeVisible();
  await header.click();
  await expect(page.locator("#inspector")).toBeVisible();
});

test("cancels a large layout and switches documents without applying stale work", async ({ page }) => {
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
      if ((message as { cmd?: string })?.cmd === "layout") document.documentElement.dataset.layoutStarted = "true";
      return Reflect.apply(post, this, [message, ...rest]);
    } as typeof post;
  });
  const code = Array.from({ length: 500 }, (_, i) => `table pending_${i} {\n id int pk\n${i ? ` previous_id int -> pending_${i - 1} index\n` : ""}${Array.from({ length: 10 }, (_, c) => ` value_${c} varchar`).join("\n")}\n}`).join("\n");
  await page.goto(`/playground/${await encode(shared(code))}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Layout cancelled");
  await expect(page.locator("#content .rz-t")).toHaveCount(0);
  await page.evaluate(() => { delete document.documentElement.dataset.layoutStarted; });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => page.locator("html").getAttribute("data-layout-started")).toBe("true");
  await page.getByRole("combobox", { name: "Example", exact: true }).selectOption({ label: "blank.erd" });
  await expect.poll(() => page.locator("#content .rz-t").count()).toBe(1);
  await expect(page.locator('#content .rz-t[data-t="things"]')).toBeVisible();
  await expect(page.locator("#content .rz-t")).toHaveCount(1);
  await expect(page.getByRole("status")).toBeHidden();
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Schema workspace" })).toContainText("Recent documents");
});

test("moves keyboard focus out of search and back when the panel closes", async ({ page }) => {
  await open(page);
  await page.locator("#find").click();
  await page.locator("#palette-input").fill("users");
  await page.locator("#palette-input").press("Enter");
  await expect(page.locator("#inspector-close")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#find")).toBeFocused();
});

test("shows the document as SQL in the side panel, follows the database and closes back to Export", async ({ page }) => {
  await open(page);
  await page.locator("#download").click();
  await page.getByRole("menuitem", { name: /SQL DDL/ }).click();
  const panel = page.getByRole("complementary", { name: "SQL" });
  await expect(panel.locator(".sql-code")).toContainText("ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users (id);");
  await expect(page.locator("#inspector-related")).toBeHidden();
  // From the keyboard, the view is rebuilt with the focus still on the database switch
  await panel.getByRole("button", { name: "MySQL" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel.locator(".sql-code")).toContainText("-- Generated by resin for MySQL");
  await expect(page.locator("#inspector-title")).toHaveText(/\.mysql\.sql$/);
  await expect(panel.getByRole("button", { name: "MySQL" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#inspector")).toBeHidden();
  await expect(page.locator("#download")).toBeFocused();
});
