import type { InventoryItem, MissingInventoryProduct } from "../shared/types";
import { suggestedProductName } from "../shared/productNames";
import { listData } from "./inventoryService";
import { loadSalesOrders } from "./salesStore";

// Discovery is read-only. Only the normal item creation workflow enrolls stock.
export async function listMissingInventoryProducts(): Promise<MissingInventoryProduct[]> {
  const [data, orders] = await Promise.all([listData(), loadSalesOrders()]);
  return findMissingInventoryProducts(data.items, orders.flatMap((order) => order.lineItems));
}

export function findMissingInventoryProducts(
  items: Pick<InventoryItem, "sku">[],
  products: { sku: string; title: string }[]
): MissingInventoryProduct[] {
  // Inactive items still own their SKU; discovery must never recreate them.
  const known = new Set(items.map((item) => item.sku.trim().toUpperCase()));
  const missing = new Map<string, MissingInventoryProduct>();
  for (const product of products) {
    const sku = product.sku.trim().toUpperCase();
    if (!sku || sku === "--" || known.has(sku) || missing.has(sku)) continue;
    missing.set(sku, { sku, name: suggestedProductName(sku, product.title) || sku });
  }
  return [...missing.values()].sort((left, right) => left.sku.localeCompare(right.sku));
}
