import { useState } from "react";
import { post, session, uuid } from "../shared/api.ts";
import { date, sar, setLocale, t, useLocale } from "../shared/i18n.ts";
import { Brand, Icon, Loadable, OtpLogin, Sadu, toast, useQuery, useSession } from "../shared/ui.tsx";

export const CUSTOMER_DEMOS: Array<[string, string]> = [["سارة (عميلة)", "0500000001"], ["فهد (عميل)", "0500000002"]];

export function Account({ go }: { go: (r: string) => void }) {
  const authed = !!useSession();
  const locale = useLocale();
  if (!authed) return <OtpLogin dark title={<span style={{ fontSize: 40 }}><Brand /></span>} subtitle="شاهد، اطلب، وتابع طلبك لين يوصل." demoPhones={CUSTOMER_DEMOS} />;
  return <AccountInner go={go} locale={locale} />;
}

function AccountInner({ go, locale }: { go: (r: string) => void; locale: string }) {
  const me = useQuery("/me");
  const loyalty = useQuery("/me/loyalty");
  const addresses = useQuery("/me/addresses");
  const tickets = useQuery("/support/tickets");
  return (
    <>
      <div className="topbar"><h1>{t("حسابي")}</h1></div>
      <div className="screen stack lg">
        <Loadable q={me}>
          {(d) => (
            <div className="row">
              <div className="grow"><h2>{d.user.name ?? "أهلاً بك"}</h2><p className="muted num" style={{ textAlign: "start" }}>{d.user.phone}</p></div>
            </div>
          )}
        </Loadable>
        <button className="plus-card stack" style={{ border: 0, textAlign: "start", cursor: "pointer" }} onClick={() => go("plus")}>
          <span className="brand" style={{ fontSize: 30 }}>أبو<b>9</b>+</span>
          <span style={{ opacity: 0.85 }}>توصيل أساسي مجاني على الطلبات المؤهلة</span>
          <Sadu total={18} on={18} />
        </button>
        <section className="panel tight stack">
          <h3>{t("نقاطي")}</h3>
          <Loadable q={loyalty}>
            {(d) => (
              <>
                <div className="row between"><span className="num" style={{ fontSize: 31, fontWeight: 700 }}>{d.balance}</span><span className="small muted">= <span className="num">{sar(d.valueHalalas)}</span></span></div>
                <p className="xs muted">{d.rules.earn} · {d.rules.redeem}</p>
                {d.expiringSoon?.points > 0 && <p className="notice small"><span className="num">{d.expiringSoon.points}</span> نقطة تنتهي في {date(d.expiringSoon.next_expiry)}</p>}
                {d.history.slice(0, 5).map((h: any, i: number) => (
                  <div key={i} className="row between small"><span>{({ earn: "ربح", campaign_earn: "مكافأة حملة", redeem: "استخدام", reverse: "عكس (استرداد)", restore: "إرجاع", expire: "انتهاء" } as any)[h.kind] ?? h.kind}{h.order_number && <> · #<span className="num">{h.order_number}</span></>}</span><span className="num">{h.delta > 0 ? "+" : ""}{h.delta}</span></div>
                ))}
              </>
            )}
          </Loadable>
        </section>
        <section className="panel tight stack">
          <h3>{t("عناويني")}</h3>
          <Loadable q={addresses}>{(d) => d.addresses.map((a: any) => (<div key={a.id} className="row small"><Icon.pin size={18} /><span className="grow">{a.label} · {a.district} <span className="muted">{a.details}</span></span>{a.is_default && <span className="badge">افتراضي</span>}</div>))}</Loadable>
          <p className="xs muted">إضافة عنوان بالخريطة تتطلب مزوّد خرائط — مدرجة في قائمة العمل.</p>
        </section>
        <Loadable q={tickets}>
          {(d) => d.tickets.length > 0 ? (
            <section className="panel tight stack">
              <h3>طلبات الدعم</h3>
              {d.tickets.map((tk: any) => (<div key={tk.id} className="row between small"><span>#<span className="num">{tk.number}</span> · {tk.reason_code}</span><span className={`badge ${tk.status === "resolved" ? "ok" : "warn"}`}>{tk.status === "resolved" ? "محلول" : "قيد المراجعة"}</span></div>))}
            </section>
          ) : null}
        </Loadable>
        <section className="panel tight row between">
          <span>{t("لغة التطبيق")}</span>
          <div className="row" style={{ gap: 6 }}>
            <button className="chip" aria-pressed={locale === "ar"} onClick={() => setLocale("ar")}>العربية</button>
            <button className="chip" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>English</button>
          </div>
        </section>
        <button className="btn danger" onClick={() => { void post("/auth/logout").catch(() => null); session.set(null); }}>{t("تسجيل الخروج")}</button>
      </div>
    </>
  );
}

export function PlusPage({ go }: { go: (r: string) => void }) {
  const authed = !!useSession();
  const q = useQuery(authed ? "/plus" : null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(uuid);
  if (!authed) return <Account go={go} />;
  const act = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); await q.reload(); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="topbar"><button className="btn ghost sm" onClick={() => go("account")} aria-label="رجوع"><Icon.back /></button><h1>أبو9+</h1></div>
      <div className="screen stack lg">
        <Loadable q={q}>
          {(d) => (
            <>
              <section className="plus-card stack lg" style={{ paddingBottom: 36 }}>
                <span className="brand" style={{ fontSize: 44 }}>أبو<b>9</b>+</span>
                {d.subscription ? (
                  <div className="stack" style={{ gap: 4 }}>
                    <span className="badge ok" style={{ alignSelf: "flex-start" }}>{d.subscription.status === "cancelled" ? "ملغى — المزايا مستمرة حتى نهاية الفترة" : d.subscription.status === "past_due" ? "تعذّر التجديد" : "مشترك"}</span>
                    <p style={{ opacity: 0.85 }}>يتجدد في {date(d.subscription.current_period_end)}</p>
                    {d.savings && <p>وفّرت <span className="num">{sar(d.savings.s)}</span> على <span className="num">{d.savings.n}</span> طلب</p>}
                  </div>
                ) : (
                  <div className="stack" style={{ gap: 2 }}>
                    <span className="num" style={{ fontSize: 40, fontWeight: 700, color: "var(--c-saffron)" }}>{sar(d.offer.price)}</span>
                    <span style={{ opacity: 0.8 }}>شهرياً · سعر تجريبي قيد الاختبار</span>
                  </div>
                )}
                <Sadu total={18} on={18} />
              </section>
              <section className="panel stack">
                <h3>المزايا والشروط</h3>
                <ul className="stack small" style={{ margin: 0, paddingInlineStart: 18 }}>
                  {d.benefits.ar.map((b: string) => <li key={b}>{b}</li>)}
                </ul>
                <p className="xs muted">أبو9+ ليس توصيلاً مجانياً لأي مسافة: رسوم المسافة بعد أول ٢ كم تُدفع كاملة.</p>
              </section>
              {!d.subscription && <button className="btn primary lg" disabled={busy} onClick={() => void act(() => post("/plus/subscribe", { paymentToken: "tok_visa_test" }, { "idempotency-key": key }), "تم تفعيل أبو9+")}>اشترك الآن (بطاقة اختبار)</button>}
              {d.subscription?.status === "active" && <button className="btn danger" disabled={busy} onClick={() => void act(() => post("/plus/cancel"), "تم الإلغاء — المزايا مستمرة حتى نهاية الفترة")}>إلغاء الاشتراك</button>}
              {d.subscription?.status === "cancelled" && <button className="btn" disabled={busy} onClick={() => void act(() => post("/plus/resume"), "تم استئناف الاشتراك")}>استئناف الاشتراك</button>}
            </>
          )}
        </Loadable>
      </div>
    </>
  );
}
