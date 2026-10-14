import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, get, post, session } from "./api.ts";
import { t } from "./i18n.ts";

// ───────────────────────── data hooks ─────────────────────────
export function useQuery<T = any>(path: string | null, opts: { poll?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!path) return;
    try {
      const d = await get<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e as ApiError);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    setLoading(!!path);
    void load();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (opts.poll) timer = setInterval(() => void load(), opts.poll);
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
  }, [load, opts.poll]);
  return { data, error, loading, reload: load, setData };
}

export function useSession() {
  return useSyncExternalStore(session.subscribe, () => session.token);
}

/** Wrap an async action: tracks busy state and shows errors as toasts. */
export function useAction<A extends unknown[]>(fn: (...a: A) => Promise<unknown>, okMsg?: string) {
  const [busy, setBusy] = useState(false);
  const run = async (...a: A) => {
    setBusy(true);
    try {
      const r = await fn(...a);
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast((e as Error).message || "حدث خطأ", true);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return [run, busy] as const;
}

// ───────────────────────── toast ─────────────────────────
let toastHost: ((m: { text: string; bad: boolean } | null) => void) | null = null;
export function toast(text: string, bad = false) {
  toastHost?.({ text, bad });
}
export function ToastHost() {
  const [m, setM] = useState<{ text: string; bad: boolean } | null>(null);
  useEffect(() => {
    toastHost = (x) => {
      setM(x);
      if (x) setTimeout(() => setM((cur) => (cur === x ? null : cur)), 3200);
    };
    return () => {
      toastHost = null;
    };
  }, []);
  return m ? (
    <div className={`toast ${m.bad ? "bad" : ""}`} role="status" aria-live="polite">
      {m.text}
    </div>
  ) : null;
}

// ───────────────────────── primitives ─────────────────────────
export function Sheet({ onClose, children, label, center }: { onClose: () => void; children: ReactNode; label: string; center?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className={`scrim ${center ? "center" : ""}`} onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        {children}
      </div>
    </div>
  );
}

export function Sadu({ total, on, now }: { total: number; on: number; now?: boolean }) {
  return (
    <div className="sadu" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={`${i < on ? "on" : ""} ${now && i === on - 1 ? "now" : ""}`} />
      ))}
    </div>
  );
}

export function Brand({ suffix }: { suffix?: string }) {
  return (
    <span className="brand" aria-label="أبو9">
      أبو<b>9</b>
      {suffix && <span className="small muted" style={{ marginInlineStart: 8, fontFamily: "var(--f-body)", fontWeight: 500 }}>{suffix}</span>}
    </span>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="notice bad row between" role="alert">
      <span>{error.message}</span>
      {retry && (
        <button className="btn sm" onClick={retry}>
          إعادة المحاولة
        </button>
      )}
    </div>
  );
}

export function Skeleton({ h = 18, w = "100%", n = 1 }: { h?: number; w?: string | number; n?: number }) {
  return (
    <div className="stack">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: h, width: w }} />
      ))}
    </div>
  );
}

export function Loadable<T>({ q, children, skeleton }: { q: { data: T | null; error: Error | null; loading: boolean; reload: () => void }; children: (d: T) => ReactNode; skeleton?: ReactNode }) {
  if (q.error && !q.data) return <ErrorBox error={q.error} retry={q.reload} />;
  if (!q.data) return <>{skeleton ?? <Skeleton n={4} h={44} />}</>;
  return <>{children(q.data)}</>;
}

const STATUS: Record<string, [string, string]> = {
  pending_payment: ["بانتظار الدفع", "warn"],
  placed: ["جديد", "warn live"],
  accepted: ["مقبول", ""],
  preparing: ["قيد التحضير", ""],
  ready_for_pickup: ["جاهز للاستلام", "ok"],
  picked_up: ["في الطريق", "ok live"],
  delivered: ["تم التوصيل", "ok"],
  rejected: ["مرفوض", "bad"],
  cancelled: ["ملغى", "bad"],
  delivery_failed: ["تعذّر التوصيل", "bad"],
  unassigned: ["بدون مندوب", "bad live"],
  assigned: ["مُسند", ""],
  at_pickup: ["عند المطعم", ""],
  at_dropoff: ["عند العميل", "ok"],
  failed: ["فشل", "bad"],
  open: ["مفتوح", "warn"],
  disputed: ["معترض عليه", "warn"],
  deductible: ["قابل للخصم", ""],
  deducted: ["مخصوم", ""],
  absorbed: ["تتحمله أبو9", ""],
  accepted_claim: ["مقبول", ""],
  resolved: ["محلول", "ok"],
  draft: ["مسودة", "warn"],
  approved: ["معتمد", "ok"],
  paid: ["مدفوع", "ok"],
  pending_review: ["بانتظار المراجعة", "warn"],
  removed: ["محذوف", "bad"],
  active: ["فعّال", "ok"],
  trialing: ["فترة تجريبية", "warn"],
  online: ["متصل", "ok live"],
  offline: ["غير متصل", ""],
  on_break: ["استراحة", "warn"],
  suspended: ["موقوف", "bad"],
  paused: ["متوقف", "bad"],
  restricted: ["مقيّد", "warn"],
  pending: ["قيد الانتظار", "warn"],
};
export function StatusBadge({ s }: { s: string }) {
  const [label, cls] = STATUS[s] ?? [s, ""];
  return <span className={`badge ${cls}`}>{label}</span>;
}

// ───────────────────────── icons (inline, 24px, stroke) ─────────────────────────
const I = (d: ReactNode) => (p: { size?: number }) => (
  <svg width={p.size ?? 24} height={p.size ?? 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
export const Icon = {
  play: I(<path d="M7 4.5v15l12-7.5z" />),
  store: I(<><path d="M4 9h16l-1.5-5h-13z" /><path d="M5 9v11h14V9" /><path d="M10 20v-6h4v6" /></>),
  bag: I(<><path d="M5 8h14l-1 12H6z" /><path d="M9 8a3 3 0 0 1 6 0" /></>),
  receipt: I(<><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>),
  user: I(<><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>),
  heart: I(<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />),
  share: I(<><path d="M12 3v12" /><path d="M7 8l5-5 5 5" /><path d="M5 14v6h14v-6" /></>),
  back: I(<path d="M9 6l6 6-6 6" />),
  close: I(<path d="M6 6l12 12M18 6L6 18" />),
  pin: I(<><path d="M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z" /><circle cx="12" cy="9" r="2.5" /></>),
  search: I(<><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>),
  bike: I(<><circle cx="6" cy="17" r="3" /><circle cx="18" cy="17" r="3" /><path d="M6 17l4-8h5l3 8M10 9l-1-3H7" /></>),
  check: I(<path d="M5 12l5 5 9-10" />),
  sound: I(<><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16 9a4 4 0 0 1 0 6" /></>),
  mute: I(<><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M17 9l4 6M21 9l-4 6" /></>),
};

// ───────────────────────── OTP login (shared by all apps) ─────────────────────────
export function OtpLogin({ title, subtitle, demoPhones, dark }: { title: ReactNode; subtitle: string; demoPhones: Array<[string, string]>; dark?: boolean }) {
  const [phone, setPhone] = useState("");
  const [ch, setCh] = useState<{ challengeId: string; devCode?: string; phone: string } | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = async (p = phone) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post("/auth/otp/request", { phone: p });
      setCh(r);
      if (r.devCode) setCode(r.devCode);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post("/auth/otp/verify", { challengeId: ch!.challengeId, code });
      session.set(r.token);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login" style={dark ? undefined : { background: "var(--c-mist)" }}>
      <div className="panel stack lg">
        <div className="stack">
          {title}
          <p className="muted">{subtitle}</p>
        </div>
        {!ch ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void request();
            }}
          >
            <div className="field">
              <label htmlFor="phone">{t("رقم الجوال")}</label>
              <input id="phone" className="input num" inputMode="tel" autoComplete="tel" placeholder="05X XXX XXXX" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ textAlign: "start" }} />
            </div>
            {err && <p className="error-text">{err}</p>}
            <button className="btn primary lg block" disabled={busy || phone.length < 9}>
              {t("أرسل الرمز")}
            </button>
            {demoPhones.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <p className="xs muted">حسابات تجريبية (بيانات وهمية):</p>
                <div className="row wrap" style={{ gap: 6 }}>
                  {demoPhones.map(([label, p]) => (
                    <button type="button" key={p} className="chip" onClick={() => { setPhone(p); void request(p); }}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </form>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
          >
            <p className="small">
              أرسلنا رمزاً إلى <span className="num">{ch.phone}</span>
            </p>
            <div className="field">
              <label htmlFor="code">{t("رمز التحقق")}</label>
              <input id="code" className="input code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              {ch.devCode && <span className="hint">بيئة التطوير: الرسائل النصية وهمية والرمز معبأ تلقائياً.</span>}
            </div>
            {err && <p className="error-text">{err}</p>}
            <button className="btn primary lg block" disabled={busy || code.length !== 6}>
              {t("دخول")}
            </button>
            <button type="button" className="btn ghost" onClick={() => setCh(null)}>
              تغيير الرقم
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── dashboard shell ─────────────────────────
export function useHashRoute(defaultRoute: string): [string, (r: string) => void] {
  const read = () => location.hash.replace(/^#\/?/, "") || defaultRoute;
  const [r, setR] = useState(read);
  useEffect(() => {
    const h = () => setR(read());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return [r, (x: string) => (location.hash = `/${x}`)];
}

export function DashShell({ sub, nav, route, children, foot }: { sub: string; nav: Array<[string, string]>; route: string; children: ReactNode; foot?: ReactNode }) {
  const base = route.split("/")[0];
  return (
    <div className="dash">
      <nav className="rail" aria-label="القائمة">
        <Brand />
        <div className="sub">{sub}</div>
        {nav.map(([key, label]) => (
          <a key={key} href={`#/${key}`} aria-current={base === key ? "page" : undefined}>
            {label}
          </a>
        ))}
        <div className="foot stack" style={{ gap: 8 }}>
          {foot}
          <button className="btn sm" onClick={() => { void post("/auth/logout").catch(() => null); session.set(null); }}>
            تسجيل الخروج
          </button>
        </div>
      </nav>
      <main className="main">{children}</main>
      <ToastHost />
    </div>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header>
      <div className="stack" style={{ gap: 4 }}>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}

export function Kpis({ items }: { items: Array<{ v: ReactNode; l: string; d?: ReactNode }> }) {
  return (
    <div className="kpis">
      {items.map((k, i) => (
        <div className="kpi" key={i}>
          <div className="v">{k.v}</div>
          <div className="l">{k.l}</div>
          {k.d && <div className="d">{k.d}</div>}
        </div>
      ))}
    </div>
  );
}

export function mount(App: () => ReactNode) {
  createRoot(document.getElementById("root")!).render(<App />);
}

/** Prompt for a required reason (sensitive actions are audited with the reason). */
export function askReason(q = "سبب الإجراء (يُسجل في سجل التدقيق):"): string | null {
  const r = window.prompt(q);
  return r && r.trim().length >= 3 ? r.trim() : null;
}
