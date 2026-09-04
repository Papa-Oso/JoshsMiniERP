// Transitional names for marketplace products awaiting a canonical Inventory item.
const productNames = new Map([
  ["JW-AR7-EDGE-001", "S-R7 Edge"],
  ["JW-AR7-FREECOM-001", "S-R7 Freecom"]
]);

export function suggestedProductName(sku: string, title: string) {
  return productNames.get(sku.trim().toUpperCase()) ?? title.trim();
}
