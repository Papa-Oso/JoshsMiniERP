import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.UI_SMOKE_URL || "http://127.0.0.1:5175";
const outputDir = path.resolve(process.env.UI_SMOKE_OUTPUT_DIR || "data/ui-smoke");

const toolPages = [
  { label: "Inventory", h1: "Inventory Sync", button: /^Inventory/ },
  { label: "Item Management", h1: "Item Management", button: /Item Management/ },
  { label: "Review", h1: "Review", button: /^Review/ },
  { label: "Printing", h1: "Printing", button: /^Printing/ },
  { label: "eBay Reviews", h1: "eBay Reviews", button: /eBay Reviews/ }
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
    await page.screenshot({ path: path.join(outputDir, `${slug(tool.label)}-desktop.png`), fullPage: true });
  }

  const mobile = await browser.newPage({ viewport: { width: 390, height: 900 }, isMobile: true });
  await mobile.goto(baseUrl, { waitUntil: "networkidle" });
  await expectHeading(mobile, "Review");
  await expectPanels(mobile);
  await mobile.screenshot({ path: path.join(outputDir, "review-landing-mobile.png"), fullPage: true });

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

async function expectPanels(page) {
  const panels = await page.locator(".panel").count();
  if (panels < 1) throw new Error("Expected at least one panel to render.");
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
