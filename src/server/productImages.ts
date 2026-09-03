import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

export const productPhotoDirectory = path.join(path.dirname(config.dataFile), "product photos");

export async function loadProductImages(directory = productPhotoDirectory) {
  const images = new Map<string, string>();
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  // Prefer the unsuffixed photo, then the front, then the rear. Never fuzzy-match SKUs.
  const candidates = entries
    .flatMap((entry) => {
      const match = /^([A-Z0-9-]+?)(-front|-rear)?\.(png|jpg|jpeg|webp)$/i.exec(entry.name);
      return entry.isFile() && match
        ? [
            {
              sku: match[1].toLowerCase(),
              filename: entry.name,
              priority: !match[2] ? 0 : match[2].toLowerCase() === "-front" ? 1 : 2
            }
          ]
        : [];
    })
    .sort((a, b) => a.priority - b.priority || a.filename.localeCompare(b.filename));
  for (const candidate of candidates) {
    if (!images.has(candidate.sku)) images.set(candidate.sku, candidate.filename);
  }
  return images;
}
