import express from "express";
import { z } from "zod";
import type { DashboardPayload } from "../shared/types";
import { getPlatformStatuses } from "./config";
import {
  adjustInventory,
  createItem,
  deleteItem,
  listData,
  updateItem,
  updateSchedule
} from "./inventoryService";
import { ebayReviewsRouter } from "./ebayReviewRoutes";
import { refreshScheduler } from "./scheduler";
import { runInventorySync } from "./syncEngine";
import { printingRouter } from "./printingRoutes";

export const router = express.Router();
router.use("/ebay-reviews", ebayReviewsRouter);
router.use("/printing", printingRouter);

const createItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  quantity: z.coerce.number().int().min(0),
  safetyStock: z.coerce.number().int().min(0).optional(),
  maxInventory: z.coerce.number().int().min(1).optional()
});

const adjustSchema = z.object({
  delta: z.coerce.number().int().refine((value) => value !== 0),
  type: z.enum(["batch_add", "manual_subtract", "correction"]).optional(),
  note: z.string().optional()
});

const mappingSchema = z.object({
  enabled: z.boolean(),
  remoteSku: z.string().optional(),
  listingId: z.string().optional(),
  inventoryItemId: z.string().optional(),
  locationId: z.string().optional(),
  offerId: z.string().optional(),
  lastSyncedQuantity: z.number().nullable().optional(),
  lastRemoteQuantity: z.number().nullable().optional(),
  lastSyncedAt: z.string().nullable().optional(),
  warning: z.string().nullable().optional()
});

const updateItemSchema = z.object({
  sku: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  safetyStock: z.coerce.number().int().min(0).optional(),
  maxInventory: z.coerce.number().int().min(1).optional(),
  active: z.boolean().optional(),
  mappings: z
    .object({
      etsy: mappingSchema.optional(),
      ebay: mappingSchema.optional(),
      shopify: mappingSchema.optional()
    })
    .optional()
});

const scheduleSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.coerce.number().int().min(5).max(1440).optional()
});

router.get("/health", (_req, res) => {
  res.json({ ok: true });
});

router.get("/dashboard", asyncHandler(async (_req, res) => {
  const data = await listData();
  const payload: DashboardPayload = {
    ...data,
    platformStatuses: getPlatformStatuses()
  };
  res.json(payload);
}));

router.post("/items", asyncHandler(async (req, res) => {
  const item = await createItem(createItemSchema.parse(req.body));
  res.status(201).json(item);
}));

router.patch("/items/:id", asyncHandler(async (req, res) => {
  const item = await updateItem(routeParam(req.params.id), updateItemSchema.parse(req.body));
  res.json(item);
}));

router.delete("/items/:id", asyncHandler(async (req, res) => {
  const item = await deleteItem(routeParam(req.params.id));
  res.json({ item, platformTouched: false });
}));

router.post("/items/:id/adjust", asyncHandler(async (req, res) => {
  const item = await adjustInventory(routeParam(req.params.id), adjustSchema.parse(req.body));
  res.json(item);
}));

router.patch("/schedule", asyncHandler(async (req, res) => {
  const schedule = await updateSchedule(scheduleSchema.parse(req.body));
  await refreshScheduler();
  res.json(schedule);
}));

router.post("/sync", asyncHandler(async (_req, res) => {
  const run = await runInventorySync("manual");
  res.json(run);
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
