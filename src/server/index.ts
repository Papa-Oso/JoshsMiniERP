import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { config } from "./config";
import { router } from "./routes";
import { startScheduler } from "./scheduler";

const app = express();

app.use(express.json({ limit: "1mb" }));
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

app.listen(config.port, "127.0.0.1", () => {
  console.log(`Inventory API listening at http://127.0.0.1:${config.port}`);
});
