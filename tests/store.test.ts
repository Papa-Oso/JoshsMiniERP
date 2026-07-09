import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InventoryStore } from "../src/server/store";
import { assertInventoryStoreContract } from "./storeContract";

test("JSON inventory store persists the inventory store contract", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "joshs-mini-erp-store-"));
  try {
    await assertInventoryStoreContract(new InventoryStore(path.join(tempDir, "inventory.json")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
