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
  return (
    <>
      {m && (
        <div className={`toast ${m.bad ? "bad" : ""}`} role="status" aria-live="polite">
          {m.text}
        </div>
      )}
      <DialogHost />
    </>
  );
}

// ───────────────────────── dialogs (replace window.prompt/confirm) ─────────────────────────
export interface AskOptions {
  title: string;
  label?: string;
  initial?: string;
  kind?: "text" | "textarea" | "number" | "confirm";
  /** Radio choices: [value, label]. */
  choices?: Array<[string, string]>;
  minLength?: number;
  min?: number;
  max?: number;
  confirmLabel?: string;
  danger?: boolean;
}
type Pending = AskOptions & { resolve: (v: string | null) => void };
let dialogHost: ((p: Pending) => void) | null = null;

/** Promise-based accessible dialog. Resolves to the entered value, or null when cancelled. */
export function ask(o: AskOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (!dialogHost) return resolve(null);
    dialogHost({ ...o, resolve });
  });
}
export const confirmDialog = (title: string, o: { label?: string; confirmLabel?: string; danger?: boolean } = {}) =>
  ask({ title, kind: "confirm", ...o }).then((v) => v !== null);

/** Ask for a required reason (sensitive actions are audited with the reason). */
export function askReason(label = "يُسجل السبب في سجل التدقيق.", title = "سبب الإجراء"): Promise<string | null> {
  return ask({ title, label, kind: "textarea", minLength: 3 }).then((r) => (r ? r.trim() : null));
}

function DialogHost() {
  const [p, setP] = useState<Pending | null>(null);
  const [v, setV] = useState("");
  useEffect(() => {
    dialogHost = (x) => {
      setV(x.initial ?? x.choices?.[0]?.[0] ?? "");
      setP(x);
    };
    return () => {
      dialogHost = null;
    };
  }, []);
  const close = useCallback((val: string | null) => {
    setP((cur) => {
      cur?.resolve(val);
      return null;
    });
  }, []);
  if (!p) return null;
  const kind = p.kind ?? "text";
  const trimmed = v.trim();
  const num = Number(v);
  const valid =
    kind === "confirm" ||
    (kind === "number" ? v !== "" && Number.isFinite(num) && (p.min === undefined || num >= p.min) && (p.max === undefined || num <= p.max) : trimmed.length >= (p.minLength ?? 1));
  return (
    <Sheet center label={p.title} onClose={() => close(null)}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) close(kind === "confirm" ? "yes" : kind === "number" ? String(num) : trimmed);
        }}
      >
        <h3>{p.title}</h3>
        {p.label && <p className="small muted">{p.label}</p>}
        {p.choices ? (
          <div className="stack" role="radiogroup" aria-label={p.title} style={{ gap: 6 }}>
            {p.choices.map(([val, label]) => (
              <label key={val} className="row" style={{ gap: 8 }}>
                <input type="radio" name="ask-choice" value={val} checked={v === val} onChange={() => setV(val)} />
                {label}
              </label>
            ))}
          </div>
        ) : kind === "textarea" ? (
          <textarea className="input" rows={3} autoFocus aria-label={p.title} value={v} onChange={(e) => setV(e.target.value)} />
        ) : kind === "text" || kind === "number" ? (
          <input className={`input ${kind === "number" ? "num" : ""}`} autoFocus aria-label={p.title} inputMode={kind === "number" ? "decimal" : undefined} value={v} onChange={(e) => setV(e.target.value)} />
        ) : null}
        {kind !== "confirm" && p.minLength && p.minLength > 1 && <span className="hint">{p.minLength} أحرف على الأقل</span>}
        <div className="row" style={{ gap: 8 }}>
          <button className={`btn ${p.danger ? "danger" : "primary"} grow`} disabled={!valid} autoFocus={kind === "confirm"}>
            {p.confirmLabel ?? "تأكيد"}
          </button>
          <button type="button" className="btn ghost grow" onClick={() => close(null)}>
            إلغاء
          </button>
        </div>
      </form>
    </Sheet>
  );
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
  onboarding: ["قيد التهيئة", "warn"],
  pending_approval: ["بانتظار الاعتماد", "warn"],
  awaiting_evidence: ["بانتظار الأدلة", "warn"],
  ended: ["منتهية", ""],
  exhausted: ["استُنفدت الميزانية", ""],
  churned: ["منسحب", ""],
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
      await post("/auth/otp/verify", { challengeId: ch!.challengeId, code, transport: "cookie" });
      session.refresh();
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
          <button className="btn sm" onClick={() => void session.logout()}>
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

// ───────────────────────── staff MFA ─────────────────────────
/** Blocks staff UIs until this session has passed TOTP (enrolment on first use). */
export function MfaGate({ children }: { children: ReactNode }) {
  const st = useQuery<{ required: boolean; verified: boolean; enrolled: boolean; devCode?: string }>("/auth/mfa");
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUri: string; devCode?: string } | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const dev = enroll?.devCode ?? st.data?.devCode;
    if (dev) setCode(dev);
  }, [enroll, st.data]);
  if (st.loading && !st.data) return <div className="login"><div className="panel"><Skeleton h={120} /></div></div>;
  const s0 = st.data;
  if (!s0 || !s0.required || s0.verified) return <>{children}</>;
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post(s0.enrolled ? "/auth/mfa/verify" : "/auth/mfa/totp/activate", { code });
      await st.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login" style={{ background: "var(--c-mist)" }}>
      <div className="panel stack lg">
        <div className="stack">
          <h2>المصادقة الثنائية</h2>
          <p className="muted">صلاحيات الموظفين لا تُفعّل إلا بعد التحقق برمز من تطبيق المصادقة مثل Google Authenticator أو 1Password.</p>
        </div>
        {!s0.enrolled && !enroll ? (
          <button className="btn primary lg block" disabled={busy} onClick={async () => { setBusy(true); try { setEnroll(await post("/auth/mfa/totp/enroll")); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }}>
            إعداد تطبيق المصادقة
          </button>
        ) : (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            {enroll && (
              <div className="stack" style={{ gap: 6 }}>
                <p className="small">أضف هذا المفتاح يدوياً في تطبيق المصادقة (نوع: حسب الوقت):</p>
                <code className="num" dir="ltr" style={{ userSelect: "all", display: "block", textAlign: "center", letterSpacing: ".04em", padding: 10, background: "var(--c-paper)", borderRadius: 10 }}>{enroll.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
                <a className="xs" href={enroll.otpauthUri}>فتح في تطبيق المصادقة على هذا الجهاز</a>
              </div>
            )}
            <div className="field">
              <label htmlFor="totp">الرمز المكوّن من ٦ أرقام</label>
              <input id="totp" className="input code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              {(enroll?.devCode ?? s0.devCode) && <span className="hint">بيئة التطوير: الرمز معبأ تلقائياً.</span>}
            </div>
            {err && <p className="error-text">{err}</p>}
            <button className="btn primary lg block" disabled={busy || code.length !== 6}>تحقق</button>
          </form>
        )}
        {err && !enroll && s0.enrolled === false && <p className="error-text">{err}</p>}
        <button type="button" className="btn ghost" onClick={() => void session.logout()}>تسجيل الخروج</button>
      </div>
    </div>
  );
}
