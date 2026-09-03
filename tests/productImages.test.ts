import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProductImages } from "../src/server/productImages";

test("product photos match exact SKUs case-insensitively and prefer primary/front images", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "erp-product-images-"));
  try {
    for (const filename of [
      "SKU-1.png",
      "SKU-1-front.jpg",
      "SKU-1-rear.png",
      "SKU-2-rear.png",
      "sku-2-FRONT.webp",
      "SKU-3.svg",
      "not a sku.png"
    ]) {
      await fs.writeFile(path.join(directory, filename), "fixture");
    }
    await fs.mkdir(path.join(directory, "SKU-4.png"));
    const images = await loadProductImages(directory);
    assert.deepEqual([...images].sort(), [
      ["sku-1", "SKU-1.png"],
      ["sku-2", "sku-2-FRONT.webp"]
    ]);
    assert.equal((await loadProductImages(path.join(directory, "missing"))).size, 0);
    await assert.rejects(loadProductImages(path.join(directory, "SKU-1.png")));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
