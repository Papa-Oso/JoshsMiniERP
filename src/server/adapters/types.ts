import type { InventoryItem, Platform, PlatformMapping } from "../../shared/types";

export interface RemoteQuantity {
  platform: Platform;
  quantity: number;
  raw?: unknown;
}

export interface PushResult {
  platform: Platform;
  quantity: number;
  raw?: unknown;
}

export interface PlatformAdapter {
  platform: Platform;
  label: string;
  isConfigured(): boolean;
  missingEnv(): string[];
  hasRequiredMapping(item: InventoryItem, mapping: PlatformMapping): boolean;
  missingMapping(item: InventoryItem, mapping: PlatformMapping): string[];
  pullQuantity(item: InventoryItem, mapping: PlatformMapping): Promise<RemoteQuantity>;
  pushQuantity(item: InventoryItem, mapping: PlatformMapping, quantity: number): Promise<PushResult>;
}

export async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = errorMessageFromPayload(payload) ?? (text || response.statusText);
    throw new Error(`${response.status} ${response.statusText}: ${message}`);
  }

  return payload as T;
}

export function mappingSku(item: InventoryItem, mapping: PlatformMapping) {
  return mapping.remoteSku?.trim() || item.sku;
}

function errorMessageFromPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  if ("error_description" in payload) return String((payload as { error_description: unknown }).error_description);
  if ("message" in payload) return String((payload as { message: unknown }).message);
  if ("error" in payload) return String((payload as { error: unknown }).error);
  if ("errors" in payload && Array.isArray((payload as { errors: unknown }).errors)) {
    return (payload as { errors: Array<Record<string, unknown>> }).errors
      .map((error) => error.longMessage ?? error.message ?? error.errorId ?? "unknown error")
      .join("; ");
  }
  return undefined;
}
