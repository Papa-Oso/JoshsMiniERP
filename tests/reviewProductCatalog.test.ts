import assert from "node:assert/strict";
import test from "node:test";
import { findSkuForTitle, unambiguousSalesProducts } from "../src/server/ebayReviews/productCatalog";

test("uses an unambiguous saved sales SKU for an exact review listing title", () => {
  const title = "Alpinestars S-R7 Helmet Adapter Mount for Cardo Packtalk Edge / Neo / Pro";
  const products = unambiguousSalesProducts([
    { lineItems: [{ title, sku: "JW-AR7-EDGE-001" }] },
    { lineItems: [{ title, sku: "JW-AR7-EDGE-001" }] }
  ]).map((record) => ({
    ...record,
    normalizedTitle: "alpinestars s r7 helmet adapter mount for cardo packtalk edge neo pro"
  }));

  assert.equal(findSkuForTitle(products, title), "JW-AR7-EDGE-001");
});

test("does not confuse an Alpinestars S-R7 review with a generic-word HJC title", () => {
  const catalog = [
    {
      title: "HJC Helmet Adapter Mount for Cardo Packtalk Edge / Neo / Pro",
      normalizedTitle: "hjc helmet adapter mount for cardo packtalk edge neo pro",
      sku: "JW-HJC-EDGE-001"
    }
  ];

  assert.equal(
    findSkuForTitle(catalog, "Alpinestars S-R7 Helmet Adapter Mount for Cardo Packtalk Edge / Neo / Pro"),
    ""
  );
});

test("omits conflicting saved sales SKUs for the same normalized title", () => {
  const title = "Shared listing title";
  assert.deepEqual(
    unambiguousSalesProducts([
      { lineItems: [{ title, sku: "SKU-ONE" }] },
      { lineItems: [{ title, sku: "SKU-TWO" }] }
    ]),
    []
  );
});
