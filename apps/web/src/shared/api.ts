// Thin typed client for the ABU9 API.
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

// Web sessions use an httpOnly cookie set by the server (JavaScript never sees the session token).
// The readable `abu9_csrf` cookie signals "logged in" and is echoed in X-CSRF-Token on writes.
const CSRF_COOKIE = "abu9_csrf";
const readCookie = (name: string): string | null => {
  const m = document.cookie.split("; ").find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
};

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
      /* storage unavailable (private mode) — preference lasts for this tab only */
    }
  },
};

// Tokens from older builds lived in localStorage; drop them.
safe.set("abu9.token", null);

let csrf: string | null = readCookie(CSRF_COOKIE);
const listeners = new Set<() => void>();

export const session = {
  /** Truthy while a session cookie is believed valid (the CSRF cookie exists). */
  get token() {
    return csrf;
  },
  /** Re-read cookies after login/logout. */
  refresh() {
    csrf = readCookie(CSRF_COOKIE);
    listeners.forEach((l) => l());
  },
  /** Forget the local session (server-side revocation happens via POST /auth/logout). */
  clear() {
    document.cookie = `${CSRF_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict`;
    session.refresh();
  },
  async logout() {
    await api("POST", "/auth/logout").catch(() => null);
    session.clear();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  csrfHeader(): Record<string, string> {
    return csrf ? { "x-csrf-token": csrf } : {};
  },
  store: safe,
};

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(method !== "GET" ? session.csrfHeader() : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && csrf) session.clear();
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
