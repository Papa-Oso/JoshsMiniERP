import type {
  AdjustInventoryInput,
  CreateItemInput,
  DashboardPayload,
  UpdateItemInput,
  UpdateScheduleInput
} from "../shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? response.statusText);
  }
  return payload as T;
}

export const api = {
  dashboard: () => request<DashboardPayload>("/api/dashboard"),
  createItem: (input: CreateItemInput) =>
    request("/api/items", { method: "POST", body: JSON.stringify(input) }),
  updateItem: (id: string, input: UpdateItemInput) =>
    request(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  adjustInventory: (id: string, input: AdjustInventoryInput) =>
    request(`/api/items/${id}/adjust`, { method: "POST", body: JSON.stringify(input) }),
  updateSchedule: (input: UpdateScheduleInput) =>
    request("/api/schedule", { method: "PATCH", body: JSON.stringify(input) }),
  runSync: () => request("/api/sync", { method: "POST" })
};
