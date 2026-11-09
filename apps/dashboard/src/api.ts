/**
 * Dashboard API client. Every /api call carries the operator token; /healthz is public.
 * The token lives in sessionStorage only, so closing the tab signs the operator out.
 */
export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const TOKEN_KEY = "boomerang.operatorToken";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the operator signs in again on reload.
  }
  window.dispatchEvent(new Event("boomerang:auth"));
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  if (res.status === 401 && path.startsWith("/api/")) setToken(null);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.error ?? body.message ?? message;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export interface Health {
  status: string;
  db: string;
}
