import express from "express";
import { z } from "zod";
import { platforms, type Platform } from "../shared/types";
import { getSalesDashboard, refreshSales } from "./salesService";

export const salesRouter = express.Router();
const querySchema = z.object({
  range: z.enum(["30d", "90d", "365d", "all"]).default("90d"),
  platform: z.enum(["all", "etsy", "ebay", "shopify"]).default("all")
});
const refreshSchema = z.object({ platforms: z.array(z.enum(["etsy", "ebay", "shopify"])).optional() });

salesRouter.get("/", asyncHandler(async (req, res) => {
  const query = querySchema.parse(req.query);
  res.json(await getSalesDashboard({ range: query.range, platform: query.platform }));
}));

salesRouter.post("/refresh", asyncHandler(async (req, res) => {
  const input = refreshSchema.parse(req.body ?? {});
  res.json(await refreshSales((input.platforms ?? platforms) as Platform[]));
}));

function asyncHandler(handler: (req: express.Request, res: express.Response) => Promise<unknown>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => { handler(req, res).catch(next); };
}
