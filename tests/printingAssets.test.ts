import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildPrintingAsset,
  decodePrintingAssetId,
  encodePrintingAssetId,
  isInsideDirectory,
  parsePrintingAssetFile,
  resolvePrintingAssetPath
} from "../src/server/printingAssets";

test("parses label assets from SKU-LABEL document filenames", () => {
  assert.deepEqual(parsePrintingAssetFile("label", "JW-HJC-BOLD-001-LABEL.docx"), {
    sku: "JW-HJC-BOLD-001",
    displayName: "JW-HJC-BOLD-001"
  });
  assert.deepEqual(parsePrintingAssetFile("label", "ABC-123-LABEL.PDF"), {
    sku: "ABC-123",
    displayName: "ABC-123"
  });
  assert.equal(parsePrintingAssetFile("label", "JW-BRAND-LOGO.docx"), undefined);
  assert.equal(parsePrintingAssetFile("label", "JW-HJC-BOLD-001-LABEL.txt"), undefined);
});

test("maps known and custom instruction filenames to instruction ids", () => {
  assert.deepEqual(parsePrintingAssetFile("instruction", "JW-HJC-INSTRUCTIONS.docx"), {
    instructionId: "hjc",
    displayName: "Jw Hjc Instructions"
  });
  assert.deepEqual(parsePrintingAssetFile("instruction", "JW-Z3-SEATBELT-INSTRUCTIONS.pdf"), {
    instructionId: "z3-seat-clips",
    displayName: "Jw Z3 Seatbelt Instructions"
  });
  assert.deepEqual(parsePrintingAssetFile("instruction", "JW-UNKNOWN-INSTRUCTIONS.docx"), {
    instructionId: "custom-unknown",
    displayName: "Jw Unknown Instructions"
  });
});

test("builds URL-safe stable ids that decode back to the asset filename", () => {
  const asset = buildPrintingAsset("label", "JW-HJC-BOLD-001-LABEL.docx", true);

  assert.ok(asset);
  assert.match(asset.id, /^label-[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodePrintingAssetId(asset.id), {
    kind: "label",
    filename: "JW-HJC-BOLD-001-LABEL.docx"
  });
  assert.equal(asset.path, "labels/JW-HJC-BOLD-001-LABEL.docx");
});

test("rejects traversal and path-shaped asset filenames", () => {
  assert.equal(parsePrintingAssetFile("label", "../JW-HJC-BOLD-001-LABEL.docx"), undefined);
  assert.equal(parsePrintingAssetFile("label", "labels/JW-HJC-BOLD-001-LABEL.docx"), undefined);
  assert.throws(
    () => encodePrintingAssetId("label", "../JW-HJC-BOLD-001-LABEL.docx"),
    /Invalid printing asset filename/
  );
  assert.throws(
    () => decodePrintingAssetId(`label-${Buffer.from("../JW-HJC-BOLD-001-LABEL.docx").toString("base64url")}`),
    /Invalid printing asset id/
  );
});

test("resolves printing asset paths inside the configured printing root", () => {
  const root = path.join(os.tmpdir(), "joshs-mini-erp-printing-assets-test");
  const resolved = resolvePrintingAssetPath("instruction", "JW-NEXX-INSTRUCTIONS.docx", root);

  assert.equal(resolved, path.resolve(root, "instructions", "JW-NEXX-INSTRUCTIONS.docx"));
  assert.equal(isInsideDirectory(root, resolved), true);
  assert.equal(isInsideDirectory(root, path.resolve(root, "..", "JW-NEXX-INSTRUCTIONS.docx")), false);
});
