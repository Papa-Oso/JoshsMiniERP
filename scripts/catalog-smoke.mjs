import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// Disposable browser fixtures only: never read or write the operator's catalog.
const outputDir = path.resolve("dist/catalog-smoke");
await mkdir(outputDir, { recursive: true });
const server = createServer(async (req, res) => {
  const filename = new URL(req.url, "http://localhost").pathname;
  const target = path.resolve("dist/client", `.${filename === "/" ? "/index.html" : filename}`);
  if (!target.startsWith(`${path.resolve("dist/client")}${path.sep}`)) { res.writeHead(403).end(); return; }
  try {
    res.setHeader("Content-Type", target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "text/html");
    res.end(await readFile(target));
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const items = [];
    let creates = 0;
    let failUpload = true;
    const printing = { instructions: [], events: [], instructionMatches: [], defaults: { labelBatchSize: 15, instructionPages: 10, instructionPerPage: 4 } };
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      if (url.pathname === "/api/dashboard") return route.fulfill({ json: {
        items, events: [], syncRuns: [], platformStatuses: [],
        schedule: { enabled: false, intervalMinutes: 60, lastRunAt: null, nextRunAt: null, updatedAt: "2026-09-04T00:00:00Z" }
      } });
      if (url.pathname === "/api/catalog/missing") return route.fulfill({ json: items.length ? [] : [
        { sku: "JW-AR7-EDGE-001", name: "S-R7 Edge" }
      ] });
      if (url.pathname === "/api/printing") return route.fulfill({ json: printing });
      if (["/api/printing/assets", "/api/printing/printers"].includes(url.pathname)) return route.fulfill({ json: [] });
      if (url.pathname === "/api/items" && method === "POST") {
        creates++;
        const input = route.request().postDataJSON();
        const item = { ...input, id: "fixture-product", active: true, mappings: {}, createdAt: "2026-09-04T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z" };
        items.push(item);
        return route.fulfill({ status: 201, json: item });
      }
      if (url.pathname === "/api/items/fixture-product" && method === "PATCH") {
        Object.assign(items[0], route.request().postDataJSON());
        return route.fulfill({ json: items[0] });
      }
      if (url.pathname === "/api/printing/labels/upload" && failUpload) return route.fulfill({ status: 400, json: { error: "Test upload failure" } });
      if (url.pathname.startsWith("/api/printing/instruction-matches/")) return route.fulfill({ json: {} });
      return route.fulfill({ status: 503, json: { error: "Unavailable in catalog fixture" } });
    });
    await page.goto(baseUrl);
    await navigate(page, "Item Management");
    await page.getByLabel("Missing from Inventory", { exact: true }).selectOption("JW-AR7-EDGE-001");
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "S-R7 Edge");
    await page.screenshot({ path: path.join(outputDir, `discovery-${width}.png`), fullPage: true });
    // Missing required upload must fail before creating a product.
    await page.locator("select").filter({ has: page.locator('option[value="upload"]') }).selectOption("upload");
    await page.getByRole("button", { name: "Save SKU", exact: true }).click();
    await page.getByText("Choose an instruction document to upload.", { exact: true }).waitFor();
    assert.equal(creates, 0);
    await page.locator("select").filter({ has: page.locator('option[value="upload"]') }).selectOption("auto");
    await page.getByLabel("Upload Label Doc").setInputFiles({ name: "fixture.pdf", mimeType: "application/pdf", buffer: Buffer.from("fixture") });
    await page.getByRole("button", { name: "Save SKU", exact: true }).click();
    await page.getByText(/saved\. Setup or refresh failed: Test upload failure/).waitFor();
    await page.getByRole("heading", { name: "Edit SKU", exact: true }).waitFor();
    assert.equal(creates, 1);
    assert.equal(items[0].quantity, 0);
    await page.screenshot({ path: path.join(outputDir, `item-management-${width}.png`), fullPage: true });
    failUpload = false;
    await page.getByRole("button", { name: "Save Changes", exact: true }).click();
    await page.getByText("JW-AR7-EDGE-001 saved.", { exact: true }).waitFor();
    assert.equal(creates, 1, "retry must update the saved item");
    await navigate(page, "Inventory");
    await page.getByText("S-R7 Edge", { exact: true }).waitFor({ state: "attached" });
    await page.locator("tbody tr").filter({ hasText: "JW-AR7-EDGE-001" }).click();
    await page.locator(".selected-sku").getByText("JW-AR7-EDGE-001", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(outputDir, `inventory-${width}.png`), fullPage: true });
    await navigate(page, "Printing");
    const labelSelector = page.locator(".label-print-controls select");
    await labelSelector.selectOption("fixture-product");
    assert.match(await labelSelector.textContent(), /S-R7 Edge/);
    assert.equal(await page.getByRole("button", { name: "Print Labels", exact: true }).isDisabled(), true);
    await page.screenshot({ path: path.join(outputDir, `printing-${width}.png`), fullPage: true });
    await navigate(page, "Item Management");
    assert.equal(await page.getByLabel("Missing from Inventory", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`Catalog lifecycle passed at ${width}px.`);
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

async function navigate(page, name) {
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await page.getByRole("heading", { level: 1, name: name === "Inventory" ? "Inventory Sync" : name, exact: true }).waitFor();
}
