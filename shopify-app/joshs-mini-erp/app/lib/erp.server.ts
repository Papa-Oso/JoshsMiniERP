import type { DashboardPayload } from "./erp-types";

const DEFAULT_ERP_API_BASE_URL = "http://127.0.0.1:5174/api";

export class ErpApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ErpApiError";
  }
}

export function erpApiBaseUrl() {
  return (
    process.env.ERP_API_BASE_URL?.trim().replace(/\/+$/, "") ||
    DEFAULT_ERP_API_BASE_URL
  );
}

export async function erpRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const apiToken = process.env.ERP_API_TOKEN?.trim();
  const response = await fetch(`${erpApiBaseUrl()}${normalizePath(path)}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      typeof payload?.error === "string" ? payload.error : response.statusText;
    throw new ErpApiError(message, response.status);
  }

  return payload as T;
}

export function getDashboard() {
  return erpRequest<DashboardPayload>("/dashboard");
}

export function erpErrorMessage(error: unknown) {
  if (error instanceof ErpApiError) return error.message;
  if (error instanceof TypeError) {
    return `ERP API is not reachable at ${erpApiBaseUrl()}. ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return `ERP API is not reachable at ${erpApiBaseUrl()}.`;
}

function normalizePath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}
