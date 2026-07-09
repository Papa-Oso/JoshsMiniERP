import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { config, requireProductionApiToken } from "./config";
import { router } from "./routes";
import { startScheduler } from "./scheduler";

requireProductionApiToken();

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use("/api", (req, res, next) => {
  if (!config.apiToken) {
    next();
    return;
  }

  const bearerToken = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  const headerToken = req.get("x-erp-api-token");
  if (bearerToken === config.apiToken || headerToken === config.apiToken) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized." });
});
app.use("/api", router);

const clientDist = path.resolve("dist/client");
try {
  await fs.access(clientDist);
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
} catch {
  // Vite serves the client during development.
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("not found") ? 404 : 400;
  res.status(status).json({ error: message });
});

await startScheduler();

app.listen(config.port, config.host, () => {
  console.log(`Inventory API listening at http://${config.host}:${config.port}`);
});
