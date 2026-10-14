import { useEffect, useState } from "react";
import { post, session } from "../shared/api.ts";
import { time, minutesUntil } from "../shared/i18n.ts";
import { ask, confirmDialog, Brand, Empty, Icon, Loadable, OtpLogin, StatusBadge, ToastHost, mount, toast, useHashRoute, useQuery, useSession } from "../shared/ui.tsx";

const DEMOS: Array<[string, string]> = [["عبدالله (سهم)", "0500000201"], ["ناصر (رواحل)", "0500000204"]];

const NEXT: Record<string, { action: string; label: string; needsCode?: "pickup" | "dropoff" }> = {
  assigned: { action: "arrive-pickup", label: "وصلت للمطعم" },
  at_pickup: { action: "pickup", label: "استلمت الطلب", needsCode: "pickup" },
  picked_up: { action: "arrive-dropoff", label: "وصلت للعميل" },
  at_dropoff: { action: "deliver", label: "تم التسليم", needsCode: "dropoff" },
};

function mapsLink(lat: number, lng: number) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

function JobCard({ j, reload }: { j: any; reload: () => void }) {
  const next = NEXT[j.status];
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const toPickup = j.status === "assigned" || j.status === "at_pickup";
  const run = async (path: string, body: unknown = {}) => {
    setBusy(true);
    try {
      await post(`/courier/jobs/${j.id}/${path}`, body);
      setCode("");
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const lateIn = minutesUntil(j.promised_by);
  return (
    <section className="panel stack">
      <div className="row between">
        <h3>#<span className="num">{j.number}</span> · {j.restaurant_name_ar}</h3>
        <StatusBadge s={j.status} />
      </div>
      {j.batched_with_job_id && <span className="badge warn" style={{ alignSelf: "flex-start" }}>طلب مجمّع مع طلب آخر</span>}
      <div className="stack small" style={{ gap: 6 }}>
        <div className="row"><Icon.store size={18} /><span className="grow">{j.branch_name_ar}</span>{toPickup && <span className="muted">جاهز {time(j.ready_at)}</span>}</div>
        <div className="row"><Icon.pin size={18} /><span className="grow">{j.customer_name ?? "العميل"} · {j.address?.district ?? ""} {j.address?.details ?? ""}</span></div>
        {j.notes && <div className="notice small">ملاحظة: {j.notes}</div>}
        <div className="row xs muted" style={{ gap: 12 }}>
          <span><span className="num">{j.item_count}</span> أصناف</span>
          <span><span className="num">{Number(j.distance_km).toFixed(1)}</span> كم</span>
          <span className={lateIn !== null && lateIn < 5 ? "error-text" : ""}>الموعد {time(j.promised_by)}</span>
          {j.status === "assigned" && j.suggested_depart_at && new Date(j.suggested_depart_at) > new Date() && <span>انطلق {time(j.suggested_depart_at)}</span>}
        </div>
      </div>
      <a className="btn" href={toPickup ? mapsLink(j.pickup_lat, j.pickup_lng) : mapsLink(j.dropoff_lat, j.dropoff_lng)} target="_blank" rel="noreferrer">
        الملاحة إلى {toPickup ? "المطعم" : "العميل"}
      </a>
      {next?.needsCode && (
        <div className="field">
          <label htmlFor={`c-${j.id}`}>{next.needsCode === "pickup" ? "رمز الاستلام من المطعم" : "رمز التسليم من العميل"}</label>
          <input id={`c-${j.id}`} className="input code" inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        </div>
      )}
      {next && (
        <button className="btn primary lg" disabled={busy || (!!next.needsCode && code.length !== 4)} onClick={() => void run(next.action, next.needsCode ? { code } : {})}>
          {next.label}
        </button>
      )}
      <div className="row">
        {j.status === "assigned" && <button className="btn sm grow" disabled={busy} onClick={async () => { const r = await ask({ title: "رفض هذا الطلب؟", label: "سيُعاد توزيعه على مندوب آخر فوراً.", choices: [["too_far", "المسافة بعيدة"], ["vehicle_issue", "مشكلة في المركبة"], ["safety", "موقع غير آمن"], ["other", "سبب آخر"]], confirmLabel: "رفض", danger: true }); if (r) void run("reject", { reason: r }); }}>رفض</button>}
        {(j.status === "picked_up" || j.status === "at_dropoff") && (
          <button className="btn sm danger grow" disabled={busy} onClick={async () => { const r = await ask({ title: "تعذّر التسليم", label: "صف ما حدث (العميل لا يرد، العنوان غير صحيح…). يُراجع مركز العمليات الحالة.", kind: "textarea", minLength: 5, confirmLabel: "تأكيد تعذّر التسليم", danger: true }); if (r) void run("fail", { reason: r }); }}>تعذّر التسليم</button>
        )}
      </div>
    </section>
  );
}

function App() {
  const authed = !!useSession();
  const [route, go] = useHashRoute("jobs");
  if (!authed) return (<><OtpLogin dark title={<span style={{ fontSize: 36 }}><Brand suffix="للمناديب" /></span>} subtitle="سجّل دخولك برقم جوالك المسجّل لدى شركة التوصيل." demoPhones={DEMOS} /><ToastHost /></>);
  return <Inner route={route} go={go} />;
}

function Inner({ route, go }: { route: string; go: (r: string) => void }) {
  const me = useQuery("/courier/me", { poll: 30_000 });
  const jobs = useQuery(`/courier/jobs?scope=${route === "history" ? "history" : "active"}`, { poll: 8_000 });
  const online = me.data?.courier.status === "online";

  // Location sharing while online (browser geolocation; falls back to nothing if denied).
  useEffect(() => {
    if (!online || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => void post("/courier/location", { lat: p.coords.latitude, lng: p.coords.longitude }).catch(() => null),
      () => null,
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [online]);

  const setStatus = async (status: string) => {
    try {
      await post("/courier/status", { status });
      await me.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="phone">
      <div className="topbar" style={{ background: "var(--c-ink)", color: "#fff" }}>
        <Brand />
        <span className="grow" />
        {me.data && (
          <button className={`btn sm ${online ? "primary" : ""}`} onClick={() => void setStatus(online ? "offline" : "online")} aria-pressed={online}>
            {online ? "متصل" : "غير متصل"}
          </button>
        )}
      </div>
      <div className="screen stack lg" style={{ paddingTop: 16 }}>
        <Loadable q={me}>
          {(d) => (
            <div className="panel tight row between">
              <div><strong>{d.courier.display_name}</strong><div className="xs muted">{d.company.name_ar}</div></div>
              <div className="row" style={{ gap: 16, textAlign: "center" }}>
                <div><div className="num" style={{ fontWeight: 700, fontSize: 20 }}>{d.today.delivered}</div><div className="xs muted">اليوم</div></div>
                <div><div className="num" style={{ fontWeight: 700, fontSize: 20 }}>{Number(d.today.km).toFixed(1)}</div><div className="xs muted">كم</div></div>
              </div>
            </div>
          )}
        </Loadable>
        <div className="chips">
          <button className="chip" aria-pressed={route !== "history"} onClick={() => go("jobs")}>الطلبات الحالية</button>
          <button className="chip" aria-pressed={route === "history"} onClick={() => go("history")}>السجل</button>
        </div>
        <Loadable q={jobs}>
          {(d) =>
            d.jobs.length === 0 ? (
              <Empty title={route === "history" ? "لا توجد رحلات بعد" : online ? "بانتظار طلب" : "أنت غير متصل"} body={route === "history" ? undefined : online ? "سيظهر الطلب هنا فور إسناده لك." : "اتصل لتبدأ باستقبال الطلبات."} />
            ) : route === "history" ? (
              <div className="panel tight">
                {d.jobs.map((j: any) => (
                  <div key={j.id} className="row between small" style={{ padding: "8px 0", borderBottom: "1px solid var(--c-line)" }}>
                    <span>#<span className="num">{j.number}</span> · {j.restaurant_name_ar}</span>
                    <span className="row" style={{ gap: 8 }}><StatusBadge s={j.status} /><span className="muted">{time(j.delivered_at)}</span></span>
                  </div>
                ))}
                <p className="xs muted" style={{ marginTop: 10 }}>{me.data?.note}</p>
              </div>
            ) : (
              d.jobs.map((j: any) => <JobCard key={j.id} j={j} reload={jobs.reload} />)
            )
          }
        </Loadable>
        <button className="btn sm ghost" onClick={async () => {
          const desc = await ask({ title: "إبلاغ عن مشكلة", label: "صف المشكلة (حادث، عطل، موقع غير آمن…). يصل البلاغ لمركز العمليات فوراً.", kind: "textarea", minLength: 5, confirmLabel: "إرسال البلاغ" });
          if (desc) await post("/courier/incidents", { kind: "other", description: desc, severity: "high" }).then(() => toast("تم إبلاغ مركز العمليات")).catch((e) => toast(e.message, true));
        }}>إبلاغ عن مشكلة</button>
        <button className="btn sm ghost" onClick={async () => { if (await confirmDialog("تسجيل الخروج؟")) void session.logout(); }}>تسجيل الخروج</button>
      </div>
      <ToastHost />
    </div>
  );
}

mount(App);
