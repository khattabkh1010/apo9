// Thin typed client for the ABU9 API. Session token lives in localStorage per app.
export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const KEY = "abu9.token";
const safe = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* storage unavailable (private mode) — session lasts for this tab only */
    }
  },
};

let memToken: string | null = safe.get(KEY);
const listeners = new Set<() => void>();

export const session = {
  get token() {
    return memToken;
  },
  set(token: string | null) {
    memToken = token;
    safe.set(KEY, token);
    listeners.forEach((l) => l());
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  store: safe,
};

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(memToken ? { authorization: `Bearer ${memToken}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && memToken) session.set(null);
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "error", json?.error?.message ?? res.statusText, json?.error?.details);
  return json as T;
}

export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b: unknown = {}, h?: Record<string, string>) => api<T>("POST", p, b, h);
export const patch = <T = any>(p: string, b: unknown) => api<T>("PATCH", p, b);
export const put = <T = any>(p: string, b: unknown = {}) => api<T>("PUT", p, b);
export const del = <T = any>(p: string) => api<T>("DELETE", p);

export function uuid(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
