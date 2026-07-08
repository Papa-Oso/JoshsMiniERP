import express from "express";
import { z } from "zod";
import {
  instructionLabelForFilename,
  listPrintingAssets,
  openPrintingAsset,
  saveUploadedInstructionAsset,
  saveUploadedLabelAsset
} from "./printingAssets";
import {
  adjustInstruction,
  ensureInstruction,
  getPrintingData,
  updateInstruction,
  updateSkuInstructionMatch,
  useMatchedInstruction
} from "./printingService";

export const printingRouter = express.Router();

const updateInstructionSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  lowAlert: z.coerce.number().int().min(0).optional()
});

const adjustInstructionSchema = z.object({
  delta: z.coerce.number().int().refine((value) => value !== 0),
  type: z.enum(["print_batch", "package_use", "correction"]).optional(),
  note: z.string().optional()
});

const useMatchedInstructionSchema = z.object({
  sku: z.string().min(1),
  quantity: z.coerce.number().int().min(1)
});

const updateInstructionMatchSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }),
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("instruction"), instructionId: z.string().min(1) })
]);

const uploadInstructionSchema = z.object({
  filename: z.string().min(1),
  contentBase64: z.string().min(1),
  label: z.string().optional(),
  sku: z.string().optional()
});

const uploadLabelSchema = z.object({
  sku: z.string().min(1),
  filename: z.string().min(1),
  contentBase64: z.string().min(1)
});

printingRouter.get("/", asyncHandler(async (_req, res) => {
  res.json(await getPrintingData());
}));

printingRouter.get("/assets", asyncHandler(async (_req, res) => {
  res.json(await listPrintingAssets());
}));

printingRouter.post("/assets/:id/open", asyncHandler(async (req, res) => {
  res.json(await openPrintingAsset(routeParam(req.params.id)));
}));

printingRouter.post("/instructions/upload", asyncHandler(async (req, res) => {
  const input = uploadInstructionSchema.parse(req.body);
  const asset = await saveUploadedInstructionAsset(input);
  if (!asset.instructionId) throw new Error("Uploaded instruction could not be matched.");

  const label = input.label?.trim() || instructionLabelForFilename(asset.filename);
  const instruction = await ensureInstruction({
    id: asset.instructionId,
    label,
    matchTerms: matchTermsForLabel(label)
  });

  if (input.sku?.trim()) {
    await updateSkuInstructionMatch(input.sku, { mode: "instruction", instructionId: instruction.id });
  }

  res.status(201).json({ instruction, asset });
}));

printingRouter.post("/labels/upload", asyncHandler(async (req, res) => {
  const input = uploadLabelSchema.parse(req.body);
  const asset = await saveUploadedLabelAsset(input);
  res.status(201).json({ asset });
}));

printingRouter.patch("/instructions/:id", asyncHandler(async (req, res) => {
  res.json(await updateInstruction(routeParam(req.params.id), updateInstructionSchema.parse(req.body)));
}));

printingRouter.patch("/instruction-matches/:sku", asyncHandler(async (req, res) => {
  res.json(await updateSkuInstructionMatch(routeParam(req.params.sku), updateInstructionMatchSchema.parse(req.body)));
}));

printingRouter.post("/instructions/:id/adjust", asyncHandler(async (req, res) => {
  res.json(await adjustInstruction(routeParam(req.params.id), adjustInstructionSchema.parse(req.body)));
}));

printingRouter.post("/use-matched-instruction", asyncHandler(async (req, res) => {
  const input = useMatchedInstructionSchema.parse(req.body);
  res.json(await useMatchedInstruction(input.sku, input.quantity));
}));

function asyncHandler(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

function routeParam(value: string | string[] | undefined) {
  if (typeof value !== "string") throw new Error("Invalid route parameter.");
  return value;
}

function matchTermsForLabel(label: string) {
  return label
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((part) => part && part !== "JW" && part !== "INSTRUCTIONS");
}
