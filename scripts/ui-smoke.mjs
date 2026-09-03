import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.UI_SMOKE_URL || "http://127.0.0.1:5175";
const outputDir = path.resolve(process.env.UI_SMOKE_OUTPUT_DIR || "data/ui-smoke");

const toolPages = [
  { label: "Inventory", h1: "Inventory Sync", button: /^Inventory/ },
  { label: "Item Management", h1: "Item Management", button: /Item Management/ },
  { label: "Review", h1: "Review", button: /^Review/ },
  { label: "Sales", h1: "Sales", button: /^Sales/ },
  { label: "Printing", h1: "Printing", button: /^Printing/ },
  { label: "Marketplace Reviews", h1: "Marketplace Reviews", button: /Marketplace Reviews/ }
];

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await expectHeading(page, "Review");
  await expectPanels(page);
  await page.screenshot({ path: path.join(outputDir, "review-landing-desktop.png"), fullPage: true });

  for (const tool of toolPages) {
    if (tool.button) {
      await page.getByRole("button", { name: /Tools/ }).click();
      await page.getByRole("button", { name: tool.button }).click();
      await page.waitForTimeout(500);
    }

    await expectHeading(page, tool.h1);
    await expectPanels(page);
    if (tool.label === "Sales") {
      await expectVisible(page.getByLabel("Period"));
      await page.getByLabel("Period").selectOption("last_year");
      await page.getByLabel("Period").selectOption("custom");
      await expectVisible(page.getByLabel("From", { exact: true }));
      await expectVisible(page.getByLabel("To", { exact: true }));
      await page.getByLabel("Period").selectOption("month");
      await expectSalesProjection(page);
    }
    await page.screenshot({ path: path.join(outputDir, `${slug(tool.label)}-desktop.png`), fullPage: true });
  }

  const mobile = await browser.newPage({ viewport: { width: 390, height: 900 }, isMobile: true });
  await mobile.goto(baseUrl, { waitUntil: "networkidle" });
  await expectHeading(mobile, "Review");
  await expectPanels(mobile);
  await mobile.screenshot({ path: path.join(outputDir, "review-landing-mobile.png"), fullPage: true });
  await mobile.getByRole("button", { name: /Tools/ }).click();
  await mobile.getByRole("button", { name: /^Sales/ }).click();
  await mobile.waitForTimeout(500);
  await expectHeading(mobile, "Sales");
  await expectPanels(mobile);
  await mobile.getByLabel("Period").selectOption("month");
  await mobile.getByText("How these totals are calculated").click();
  await expectVisible(mobile.getByText(/Comparable net sales will replace Revenue/));
  await expectVisible(mobile.getByText(/currency-separated reconciliation totals/));
  await expectSalesProjection(mobile);
  await mobile.screenshot({ path: path.join(outputDir, "sales-mobile.png"), fullPage: true });

  console.log(`UI smoke screenshots written to ${outputDir}`);
} finally {
  await browser.close();
}

async function expectHeading(page, expected) {
  const heading = await page.locator("h1").first().textContent();
  if (heading?.trim() !== expected) {
    throw new Error(`Expected heading "${expected}", got "${heading ?? ""}".`);
  }
}

async function expectSalesProjection(page) {
  // Let earlier filter requests finish before replacing responses with this fixture.
  await page.waitForLoadState("networkidle");
  const endpoint = /\/api\/sales\?/;
  await page.route(endpoint, async (route) => {
    const range = new URL(route.request().url()).searchParams.get("range");
    const historical = range === "last_year";
    await route.fulfill({ json: {
      generatedAt: "2026-09-03T13:00:00Z", lastPulledAt: "2026-09-03T12:00:00Z", range, platform: "all",
      period: { startDate: historical ? "2025-01-01" : range === "month" ? "2026-09-01" : "2026-01-01", endDate: historical ? "2025-12-31" : "2026-09-03" },
      summary: { revenue: 1000, orders: 30, units: 37, averageOrderValue: 33, currency: "USD" },
      projectionHistory: [{ month: "2026-08", days: 31, revenue: 6200, orders: 310, units: 372 }],
      trend: historical ? [{ date: "2025-08-01", revenue: 8000, orders: 250, units: 300 }] : [
        ...(range === "month" ? [] : [{ date: "2026-08-01", revenue: 8000, orders: 250, units: 300 }]),
        { date: "2026-09-01", revenue: 800, orders: 25, units: 30 },
        { date: "2026-09-03", revenue: 200, orders: 5, units: 7 }
      ],
      financialSummaries: [], platforms: [], countries: [], locations: [], products: [], recentOrders: [], coverage: [], warnings: [],
      dataQuality: { unknownGeographyOrders: 0, missingSkuLines: 0 }
    } });
  });
  try {
    const response = page.waitForResponse((result) => result.url().includes("/api/sales?range=ytd"));
    await page.getByLabel("Period").selectOption("ytd");
    if ((await (await response).json()).summary.revenue !== 1000) throw new Error("Projection fixture was not applied.");
    await page.locator(".trend-projection").getByText("$7,947 revenue", { exact: true }).waitFor();
    await expectVisible(page.locator(".trend-projection").getByText(/26% this month's pace with 74% recent history/));
    await expectVisible(page.locator(".trend-projected-line"));
    const revenuePath = await page.locator(".trend-projected-line").getAttribute("d");
    await page.getByRole("group", { name: "Chart value" }).getByRole("button", { name: "Orders", exact: true }).click();
    const ordersPath = await page.locator(".trend-projected-line").getAttribute("d");
    if (revenuePath === ordersPath) throw new Error("Projected chart did not switch metrics.");
    await page.locator(".trend-plot").focus();
    await page.keyboard.press("ArrowLeft");
    await expectVisible(page.locator(".trend-chart-detail").getByText("Aug 2026", { exact: true }));
    await page.keyboard.press("ArrowRight");
    await expectVisible(page.locator(".trend-chart-detail").getByText("Sep 2026", { exact: true }));
    await page.screenshot({ path: path.join(outputDir, `sales-projection-${page.viewportSize().width}.png`), fullPage: true });
    await page.getByLabel("Period").selectOption("month");
    await page.locator(".trend-projected-line").waitFor({ state: "detached" });
    await expectVisible(page.getByText("Projected month end", { exact: true }));
    await page.getByLabel("Period").selectOption("last_year");
    await page.getByText("Projected month end", { exact: true }).waitFor({ state: "detached" });
  } finally {
    await page.unroute(endpoint);
    await page.getByLabel("Period").selectOption("month");
    await page.waitForLoadState("networkidle");
  }
}

async function expectPanels(page) {
  const panels = await page.locator(".panel").count();
  if (panels < 1) throw new Error("Expected at least one panel to render.");
}

async function expectVisible(locator) {
  if (!(await locator.isVisible())) throw new Error("Expected content to be visible.");
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
