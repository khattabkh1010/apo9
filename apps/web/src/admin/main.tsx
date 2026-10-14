import { useState } from "react";
import { patch, post, put } from "../shared/api.ts";
import { date, sar, time } from "../shared/i18n.ts";
import { ask, askReason, Brand, DashShell, Empty, Kpis, Loadable, MfaGate, OtpLogin, PageHead, Sheet, StatusBadge, ToastHost, mount, toast, useHashRoute, useQuery, useSession } from "../shared/ui.tsx";

const DEMOS: Array<[string, string]> = [["مشرف العمليات", "0500000901"], ["المالية", "0500000902"]];
const NAV: Array<[string, string]> = [
  ["overview", "نظرة عامة"], ["orders", "الطلبات"], ["dispatch", "التوزيع"], ["support", "الدعم والمطالبات"], ["content", "المحتوى والصنّاع"],
  ["finance", "المالية"], ["settlements", "التسويات"], ["growth", "أبو9+ والعروض"], ["config", "المناطق والتسعير"], ["partners", "الشركاء"], ["audit", "سجل التدقيق"],
];

function App() {
  const authed = !!useSession();
  const [route] = useHashRoute("overview");
  if (!authed) return (<><OtpLogin dark title={<span style={{ fontSize: 36 }}><Brand suffix="مركز العمليات" /></span>} subtitle="للموظفين المصرّح لهم فقط. كل إجراء حساس يُسجّل." demoPhones={DEMOS} /><ToastHost /></>);
  const [head, arg] = route.split("/");
  const pages: Record<string, React.JSX.Element> = {
    overview: <Overview />, orders: arg ? <OrderDetail id={arg} /> : <Orders />, dispatch: <Dispatch />, support: <Support />, content: <ContentPage />,
    finance: <Finance />, settlements: <Settlements />, growth: <Growth />, config: <Config />, partners: <Partners />, audit: <Audit />,
  };
  return <MfaGate><DashShell sub="مركز العمليات · الرياض" nav={NAV} route={route}>{pages[head!] ?? <Overview />}</DashShell><ToastHost /></MfaGate>;
}

const act = async (fn: () => Promise<unknown>, ok: string, after?: () => unknown) => {
  try { await fn(); toast(ok); await after?.(); } catch (e) { toast((e as Error).message, true); }
};

// ───────────────────────── overview ─────────────────────────
function Overview() {
  const q = useQuery("/admin/dashboard", { poll: 15_000 });
  return (
    <>
      <PageHead title="نظرة عامة على اليوم" sub="الأرقام من دفتر الأستاذ. قيمة الطلبات (GMV) ليست إيراد أبو9." />
      <Loadable q={q}>
        {(d) => {
          const t = d.today;
          const onTime = d.delivery.delivered ? Math.round((d.delivery.on_time / d.delivery.delivered) * 100) : null;
          const live = Object.fromEntries(d.live.map((x: any) => [x.status, x.n]));
          const max = Math.max(1, ...d.hourly.map((h: any) => h.n));
          return (
            <>
              <Kpis items={[
                { v: <span className="num">{t.total}</span>, l: "طلبات اليوم", d: <><span className="num">{t.delivered}</span> مكتمل · <span className="num">{t.lost}</span> مفقود</> },
                { v: <span className="num">{sar(t.gmv)}</span>, l: "قيمة الطلبات (GMV)", d: "ليست إيراداً" },
                { v: <span className="num">{sar(d.abu9Revenue)}</span>, l: "إيراد أبو9", d: <>مساهمة <span className="num">{sar(d.contributionToday)}</span> بعد التكاليف</> },
                { v: <span className="num">{onTime === null ? "—" : `${onTime}٪`}</span>, l: "في الموعد", d: <>متوسط <span className="num">{Math.round(d.delivery.avg_minutes)}</span> دقيقة</> },
                { v: <span className="num">{d.couriers.find((c: any) => c.status === "online")?.n ?? 0}</span>, l: "مناديب متصلون" },
              ]} />
              <div className="cols">
                <section className="panel stack">
                  <h3>الطلبات الجارية</h3>
                  {[["placed", "بانتظار المطعم"], ["preparing", "قيد التحضير"], ["ready_for_pickup", "جاهزة"], ["picked_up", "في الطريق"]].map(([k, l]) => (
                    <div key={k} className="row between"><span>{l}</span><span className="num" style={{ fontWeight: 700 }}>{live[k!] ?? 0}</span></div>
                  ))}
                </section>
                <section className="panel stack">
                  <h3>المناطق</h3>
                  {d.zones.map((z: any) => (
                    <div key={z.id} className="row between small"><span>{z.name_ar} <span className="muted num">{z.code}</span></span><span className="row" style={{ gap: 8 }}><span className="num">{z.active}</span> جارٍ <StatusBadge s={z.status} /></span></div>
                  ))}
                </section>
                <section className="panel stack">
                  <h3>الطلبات حسب الساعة</h3>
                  {d.hourly.length === 0 ? <p className="muted small">لا طلبات اليوم بعد</p> : (
                    <div className="bars">{Array.from({ length: 24 }, (_, h) => { const n = d.hourly.find((x: any) => x.h === h)?.n ?? 0; return <div key={h} style={{ height: `${(n / max) * 100}%` }} data-v={`${h}:00 · ${n}`} />; })}</div>
                  )}
                </section>
                <section className="panel stack">
                  <h3>الإيرادات والتكاليف (دفتر الأستاذ)</h3>
                  {d.revenueBreakdown.length === 0 && <p className="muted small">لا قيود اليوم</p>}
                  {d.revenueBreakdown.map((r: any) => <div key={r.code} className="row between small"><span className="num" style={{ direction: "ltr" }}>{r.code}</span><span className="num">{sar(r.amount)}</span></div>)}
                </section>
              </div>
            </>
          );
        }}
      </Loadable>
    </>
  );
}

// ───────────────────────── orders ─────────────────────────
function Orders() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const q = useQuery(`/admin/orders?${new URLSearchParams({ ...(status ? { status } : {}), ...(search ? { q: search } : {}) })}`, { poll: 10_000 });
  return (
    <>
      <PageHead title="الطلبات" actions={<>
        <input className="input" style={{ width: 200 }} placeholder="رقم الطلب أو الجوال" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" style={{ width: 170 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">كل الحالات</option>{["placed", "preparing", "ready_for_pickup", "picked_up", "delivered", "rejected", "cancelled", "delivery_failed"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </>} />
      <Loadable q={q}>
        {(d) => d.orders.length === 0 ? <Empty title="لا طلبات" /> : (
          <div className="panel table-wrap">
            <table className="table">
              <thead><tr><th>#</th><th>المطعم</th><th>العميل</th><th>المنطقة</th><th>الحالة</th><th>التوصيل</th><th>الموعد</th><th>المبلغ</th></tr></thead>
              <tbody>
                {d.orders.map((o: any) => (
                  <tr key={o.id} className="click" onClick={() => (location.hash = `/orders/${o.id}`)}>
                    <td className="num">{o.number}</td><td>{o.restaurant}</td><td>{o.customer ?? "—"}<div className="xs muted num">{o.customer_phone}</div></td><td className="num">{o.zone}</td>
                    <td><StatusBadge s={o.status} />{o.late && <span className="badge bad" style={{ marginInlineStart: 4 }}>متأخر</span>}</td>
                    <td>{o.delivery ? <>{o.delivery.courier ?? "—"} <StatusBadge s={o.delivery.status} /></> : "—"}</td>
                    <td className="num">{time(o.promised_by)}</td><td className="num">{sar(o.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Loadable>
    </>
  );
}

function OrderDetail({ id }: { id: string }) {
  const q = useQuery(`/admin/orders/${id}`);
  const intervene = async (action: string) => {
    const reason = await askReason();
    if (!reason) return;
    void act(() => post(`/admin/orders/${id}/intervene`, { action, reason, ...(action === "accept" ? { prepMinutes: 15 } : {}) }), "تم", q.reload);
  };
  return (
    <Loadable q={q}>
      {(d) => {
        const o = d.order;
        return (
          <>
            <PageHead title={`طلب #${o.number}`} sub={<>{o.restaurant} · {o.customer} <span className="num">{o.customer_phone}</span></>} actions={<>
              <a className="btn sm" href="#/orders">كل الطلبات</a>
              {o.status === "placed" && <button className="btn sm primary" onClick={() => intervene("accept")}>قبول نيابة عن المطعم</button>}
              {["accepted", "preparing"].includes(o.status) && <button className="btn sm" onClick={() => intervene("mark_ready")}>تعليم كجاهز</button>}
              {!["delivered", "rejected", "cancelled", "delivery_failed", "picked_up"].includes(o.status) && <button className="btn sm danger" onClick={() => intervene(o.status === "placed" ? "reject" : "cancel")}>إلغاء</button>}
            </>} />
            <div className="cols">
              <section className="panel stack">
                <h3>المسار الزمني</h3>
                {d.events.map((e: any) => <div key={e.id} className="row between small"><span><StatusBadge s={e.to_status} /> <span className="muted">{e.actor_type}</span>{e.note && <span className="xs muted"> · {e.note}</span>}</span><span className="num">{time(e.created_at)}</span></div>)}
                <hr className="rule" />
                <div className="small">الموعد الموعود: <span className="num">{time(o.promised_by)}</span> · المسافة <span className="num">{Number(o.road_distance_km).toFixed(2)}</span> كم ({o.route_source})</div>
              </section>
              <section className="panel stack">
                <h3>التسعير المعروض للعميل</h3>
                <div className="bill">{o.pricing.lines.map((l: any) => <div key={l.code} className={`line ${l.informational ? "info" : ""} ${l.code === "total" ? "total" : ""}`}><span>{l.labelAr}</span><span className="num">{sar(l.amount)}</span></div>)}</div>
              </section>
              <section className="panel stack">
                <h3>التوصيل وقرارات التوزيع</h3>
                {d.jobs.map((j: any) => <div key={j.id} className="small">{j.courier ?? "بدون مندوب"} · {j.company ?? ""} <StatusBadge s={j.status} />{j.compensation && <> · تكلفة <span className="num">{sar(j.compensation)}</span></>}{j.batched_with_job_id && <span className="badge warn">مجمّع</span>}</div>)}
                {d.dispatchDecisions.map((dd: any) => (
                  <details key={dd.id} className="small">
                    <summary>{dd.strategy} · {time(dd.created_at)} · {dd.decision.assignment ? "أُسند" : dd.overridden_by ? "تدخل يدوي" : "لم يُسند"}</summary>
                    <ul style={{ paddingInlineStart: 18 }}>{(dd.decision.assignment?.explanation ?? []).map((x: string, i: number) => <li key={i} style={{ direction: "ltr", textAlign: "start" }}>{x}</li>)}</ul>
                    {dd.decision.rejected?.length > 0 && <p className="xs muted" style={{ direction: "ltr" }}>rejected: {dd.decision.rejected.map((r: any) => r.reason).join(", ")}</p>}
                  </details>
                ))}
              </section>
              <section className="panel stack">
                <h3>القيود المحاسبية</h3>
                {d.ledger.map((e: any, i: number) => (
                  <div key={i} className="stack" style={{ gap: 2 }}>
                    <strong className="small num" style={{ direction: "ltr", textAlign: "start" }}>{e.event_type}</strong>
                    {e.lines.map((l: any, k: number) => <div key={k} className="row between xs"><span className="num" style={{ direction: "ltr" }}>{l.account}</span><span className="num">{l.debit ? `Dr ${sar(l.debit)}` : `Cr ${sar(l.credit)}`}</span></div>)}
                  </div>
                ))}
                {d.payments.map((p: any) => <div key={p.id} className="small">الدفع: <StatusBadge s={p.status} /> <span className="num">{sar(p.captured_amount)}</span> ({p.provider}{p.provider === "mock" ? " — وهمي" : ""})</div>)}
              </section>
            </div>
          </>
        );
      }}
    </Loadable>
  );
}

// ───────────────────────── dispatch ─────────────────────────
function Dispatch() {
  const q = useQuery("/admin/dispatch", { poll: 8_000 });
  const settings = useQuery("/admin/settings");
  const batching = settings.data?.settings.find((s: any) => s.key === "batching")?.value;
  return (
    <>
      <PageHead title="لوحة التوزيع" sub={batching ? <>التجميع {batching.enabled ? "مفعّل" : "متوقف"} · حد <span className="num">{batching.maxOrdersPerCourier}</span> طلبات · انحراف <span className="num">{batching.maxDetourKm}</span> كم · تأخير <span className="num">{batching.maxAddedDelayMin}</span> د</> : undefined} />
      <Loadable q={q}>
        {(d) => (
          <div className="cols">
            <section className="panel stack">
              <h3>الرحلات المفتوحة (<span className="num">{d.jobs.length}</span>)</h3>
              {d.jobs.length === 0 && <p className="muted small">لا رحلات مفتوحة</p>}
              {d.jobs.map((j: any) => (
                <div key={j.id} className="stack" style={{ gap: 6, padding: "10px 0", borderBottom: "1px solid var(--c-line)" }}>
                  <div className="row between"><strong>#<span className="num">{j.number}</span> · {j.restaurant}</strong><StatusBadge s={j.status} /></div>
                  <div className="xs muted">الموعد <span className="num">{time(j.promised_by)}</span> · جاهز <span className="num">{time(j.ready_at)}</span> · {j.zone}{j.batched_with_job_id && " · مجمّع"}</div>
                  {j.status === "unassigned" && j.last_rejections && <div className="xs" style={{ direction: "ltr", textAlign: "start" }}>{j.last_rejections.map((r: any) => r.reason).join(" · ")}</div>}
                  <div className="row">
                    <select className="input" style={{ minHeight: 34, padding: "4px 8px" }} defaultValue="" onChange={async (e) => {
                      const courierId = e.target.value;
                      if (!courierId) return;
                      const reason = await askReason();
                      if (!reason) return;
                      void act(() => post(`/admin/dispatch/jobs/${j.id}/assign`, { courierId, reason }), "تم الإسناد يدوياً", q.reload);
                    }}>
                      <option value="">إسناد يدوي…</option>
                      {d.couriers.filter((c: any) => c.status === "online").map((c: any) => <option key={c.id} value={c.id}>{c.display_name} ({c.load}/2)</option>)}
                    </select>
                    <button className="btn sm" onClick={() => void act(() => post(`/admin/dispatch/jobs/${j.id}/redispatch`), "أعيد التوزيع", q.reload)}>إعادة التوزيع</button>
                  </div>
                </div>
              ))}
            </section>
            <section className="panel table-wrap">
              <h3>المناديب</h3>
              <table className="table"><thead><tr><th>المندوب</th><th>الشركة</th><th>الحالة</th><th>الحمل</th><th>آخر ظهور</th></tr></thead>
                <tbody>{d.couriers.map((c: any) => <tr key={c.id}><td>{c.display_name}<div className="xs muted">{c.capacity_type === "committed" ? "سعة ملتزمة" : "سعة عند الطلب"}</div></td><td>{c.company}</td><td><StatusBadge s={c.status} /></td><td className="num">{c.load}/2</td><td className="num">{time(c.last_seen_at)}</td></tr>)}</tbody>
              </table>
            </section>
          </div>
        )}
      </Loadable>
    </>
  );
}

// ───────────────────────── support ─────────────────────────
function Support() {
  const t = useQuery("/admin/tickets");
  const c = useQuery("/admin/claims");
  const inc = useQuery("/admin/incidents");
  const fraud = useQuery("/admin/fraud");
  const ap = useQuery("/admin/refund-approvals");
  const resolve = async (tk: any) => {
    const fault = await ask({ title: "الجهة المسؤولة عن المشكلة", choices: [["restaurant", "المطعم"], ["logistics", "شركة التوصيل"], ["abu9", "أبو9"], ["customer", "العميل"], ["external", "ظرف خارجي"]] });
    if (!fault) return;
    const amt = await ask({ title: "مبلغ الاسترداد (ريال)", label: `من 0 حتى ${(tk.total / 100).toFixed(2)} — 0 يعني بدون استرداد`, kind: "number", initial: "0", min: 0, max: tk.total / 100 });
    if (amt === null) return;
    const note = await askReason("يُحفظ مع التذكرة وفي سجل التدقيق.", "ملخص الأدلة والقرار");
    if (!note) return;
    try {
      const r = await post(`/admin/tickets/${tk.id}/resolve`, { faultParty: fault, refundAmount: Math.round(Number(amt) * 100), note });
      toast(r.pendingApproval ? `المبلغ فوق ${sar(r.threshold)}: أُرسل لاعتماد مدير آخر` : "تم حل التذكرة");
      await Promise.all([t.reload(), ap.reload()]);
    } catch (e) { toast((e as Error).message, true); }
  };
  const decide = async (a: any, approve: boolean) => {
    const reason = await askReason(approve ? `استرداد ${sar(a.amount)} للطلب #${a.order_number}. سينفَّذ فوراً عند الاعتماد.` : "يعود الطلب للتذكرة لمراجعة جديدة.", approve ? "اعتماد الاسترداد" : "رفض الاسترداد");
    if (reason) await act(() => post(`/admin/refund-approvals/${a.id}/decide`, { approve, reason }), approve ? "اعتُمد ونُفّذ الاسترداد" : "رُفض", async () => { await Promise.all([ap.reload(), t.reload()]); });
  };
  return (
    <>
      <PageHead title="الدعم والمطالبات" sub="نعوّض العميل بسرعة على حساب أبو9، ثم نسترد من الشريك فقط عبر مطالبة قابلة للاعتراض وبحسب العقد." />
      <div className="stack lg">
        <Loadable q={ap}>{(d) => d.approvals.length === 0 ? null : (
          <section className="panel stack"><h3>استردادات بانتظار اعتماد ثانٍ (<span className="num">{d.approvals.length}</span>)</h3>
            <p className="xs muted">مبدأ «أربع أعين»: من اقترح الاسترداد لا يعتمده.</p>
            {d.approvals.map((a: any) => (
              <div key={a.id} className="row between small" style={{ gap: 8 }}>
                <span>#<span className="num">{a.order_number}</span> · {a.reason_code} · <strong className="num">{sar(a.amount)}</strong> · اقترحه {a.proposed_by_name ?? "—"}<div className="xs muted">{a.note}</div></span>
                <span className="row" style={{ gap: 4 }}><button className="btn sm primary" onClick={() => void decide(a, true)}>اعتماد</button><button className="btn sm ghost" onClick={() => void decide(a, false)}>رفض</button></span>
              </div>
            ))}
          </section>)}</Loadable>
        <Loadable q={t}>{(d) => (
          <section className="panel table-wrap"><h3>التذاكر</h3>
            <table className="table"><thead><tr><th>#</th><th>العميل</th><th>السبب</th><th>المبلغ المتأثر</th><th>الجهة</th><th>الحالة</th><th /></tr></thead>
              <tbody>{d.tickets.map((tk: any) => <tr key={tk.id}><td className="num">{tk.number}</td><td>{tk.customer}</td><td>{tk.reason_code}<div className="xs muted">{tk.description}</div></td><td className="num">{sar(tk.affected_amount)}</td><td>{tk.fault_party}</td><td><StatusBadge s={tk.status} />{tk.resolution?.refundAmount > 0 && <div className="xs num">استرداد {sar(tk.resolution.refundAmount)}</div>}</td><td>{tk.status === "open" && <button className="btn sm" onClick={() => resolve(tk)}>حل</button>}</td></tr>)}</tbody>
            </table></section>)}</Loadable>
        <Loadable q={c}>{(d) => (
          <section className="panel table-wrap"><h3>مطالبات التعويض من الشركاء</h3>
            <table className="table"><thead><tr><th>#</th><th>الطرف</th><th>السبب</th><th>المبلغ</th><th>قابل للخصم بعد</th><th>الحالة</th><th /></tr></thead>
              <tbody>{d.claims.map((cl: any) => <tr key={cl.id}><td className="num">{cl.number}</td><td>{cl.party_type}</td><td>{cl.reason_code}{cl.dispute_note && <div className="xs muted">اعتراض: {cl.dispute_note}</div>}</td><td className="num">{sar(cl.amount)}</td><td className="num">{date(cl.deductible_after)}</td><td><StatusBadge s={cl.status} /></td><td>{["open", "disputed"].includes(cl.status) && <span className="row" style={{ gap: 4 }}>
                <button className="btn sm" onClick={async () => { const r = await askReason(); if (r) void act(() => post(`/admin/claims/${cl.id}/decide`, { accept: true, reason: r }), "قُبلت المطالبة", c.reload); }}>قبول</button>
                <button className="btn sm ghost" onClick={async () => { const r = await askReason(); if (r) void act(() => post(`/admin/claims/${cl.id}/decide`, { accept: false, reason: r }), "تتحملها أبو9", c.reload); }}>تتحملها أبو9</button></span>}</td></tr>)}</tbody>
            </table></section>)}</Loadable>
        <div className="cols">
          <Loadable q={inc}>{(d) => (<section className="panel stack"><h3>البلاغات الميدانية</h3>{d.incidents.length === 0 && <p className="muted small">لا بلاغات</p>}{d.incidents.map((i: any) => <div key={i.id} className="row between small"><span>{i.kind} {i.number && <>· #<span className="num">{i.number}</span></>}<div className="xs muted">{i.description}</div></span><span className="row" style={{ gap: 4 }}><span className={`badge ${i.severity === "high" || i.severity === "critical" ? "bad" : ""}`}>{i.severity}</span>{i.status !== "resolved" && <button className="btn sm" onClick={() => void act(() => post(`/admin/incidents/${i.id}/status`, { status: "resolved" }), "أُغلق البلاغ", inc.reload)}>إغلاق</button>}</span></div>)}</section>)}</Loadable>
          <Loadable q={fraud}>{(d) => (<section className="panel stack"><h3>إشارات الاحتيال</h3>{d.flags.length === 0 && <p className="muted small">لا إشارات</p>}{d.flags.map((f: any) => <div key={f.id} className="row between small"><span className="num" style={{ direction: "ltr" }}>{f.rule}</span><span className="row" style={{ gap: 4 }}><StatusBadge s={f.status} />{f.status === "open" && <><button className="btn sm" onClick={() => void act(() => post(`/admin/fraud/${f.id}`, { status: "confirmed" }), "تم", fraud.reload)}>تأكيد</button><button className="btn sm ghost" onClick={() => void act(() => post(`/admin/fraud/${f.id}`, { status: "dismissed" }), "تم", fraud.reload)}>تجاهل</button></>}</span></div>)}</section>)}</Loadable>
        </div>
      </div>
    </>
  );
}

// ───────────────────────── content & creators ─────────────────────────
function CampaignsAdmin() {
  const q = useQuery("/admin/creator-campaigns");
  const label = (c: any) => (c.incentive_type === "fixed_per_order" ? `${sar(c.incentive_value)} / طلب` : c.incentive_type === "percent_of_food" ? `${c.incentive_value / 100}٪` : "—");
  const FUND: Record<string, string> = { abu9: "أبو9", restaurant: "المطعم", shared: "مشترك" };
  const create = async () => {
    const name = await ask({ title: "حملة أبو9 جديدة", label: "تموّلها أبو9. تحتاج اعتماد مدير آخر قبل التفعيل.", minLength: 3 });
    if (!name) return;
    const type = await ask({ title: "نوع الحافز", choices: [["fixed_per_order", "مبلغ لكل طلب منسوب"], ["percent_of_food", "نسبة من قيمة الأكل"], ["none", "بدون حافز"]] });
    if (!type) return;
    const value = type === "none" ? "0" : await ask({ title: type === "percent_of_food" ? "النسبة ٪ (حتى 30)" : "المبلغ لكل طلب (ر.س، حتى 50)", kind: "number", initial: type === "percent_of_food" ? "5" : "5", min: 0.01, max: type === "percent_of_food" ? 30 : 50 });
    if (value === null) return;
    const budget = type === "none" ? "0" : await ask({ title: "الميزانية (ر.س)", kind: "number", initial: "2000", min: 1, max: 1_000_000 });
    if (budget === null) return;
    await act(() => post("/admin/creator-campaigns", { name, incentiveType: type, incentiveValue: Math.round(Number(value) * 100), budget: Math.round(Number(budget) * 100), fundedBy: "abu9", endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString() }), "أُرسلت للاعتماد", q.reload);
  };
  return (
    <Loadable q={q}>{(d) => (
      <section className="panel table-wrap" style={{ marginBottom: 20 }}>
        <div className="row between"><h3>حملات الصنّاع</h3><button className="btn sm primary" onClick={() => void create()}>+ حملة أبو9</button></div>
        <p className="xs muted">الاعتماد بمبدأ «أربع أعين»: من اقترح الحملة لا يعتمدها. لا يُصرف حافز إلا لصانع اشترك واعتمدناه، ضمن الميزانية.</p>
        <table className="table"><thead><tr><th>الحملة</th><th>المطعم</th><th>التمويل</th><th>الحافز</th><th>الصرف</th><th>الصنّاع</th><th>الحالة</th><th /></tr></thead>
          <tbody>{d.campaigns.map((c: any) => (
            <tr key={c.id}>
              <td>{c.name}<div className="xs muted">اقترحها {c.created_by_name ?? "—"}</div></td>
              <td>{c.restaurant ?? "كل المطاعم"}</td><td>{FUND[c.funded_by]}</td><td className="small">{label(c)}</td>
              <td className="num small">{sar(c.spent)} / {sar(c.budget)}</td><td className="num">{c.creators_approved}</td><td><StatusBadge s={c.status} /></td>
              <td className="row" style={{ gap: 4 }}>
                {c.status === "pending_approval" && <button className="btn sm primary" onClick={() => void act(() => post(`/admin/creator-campaigns/${c.id}/approve`, {}), "اعتُمدت", q.reload)}>اعتماد</button>}
                {(c.status === "active" || c.status === "paused") && <button className="btn sm ghost" onClick={async () => { const reason = await askReason(); if (reason) await act(() => post(`/admin/creator-campaigns/${c.id}/status`, { status: c.status === "active" ? "paused" : "active", reason }), "تم", q.reload); }}>{c.status === "active" ? "إيقاف" : "استئناف"}</button>}
                {c.status !== "ended" && <button className="btn sm ghost" onClick={async () => { const reason = await askReason(); if (reason) await act(() => post(`/admin/creator-campaigns/${c.id}/status`, { status: "ended", reason }), "انتهت", q.reload); }}>إنهاء</button>}
              </td>
            </tr>))}</tbody></table>
        {d.pendingEnrollments.length > 0 && (
          <div className="stack" style={{ marginTop: 12 }}>
            <h4>صنّاع بانتظار الاعتماد</h4>
            {d.pendingEnrollments.map((e: any) => <div key={`${e.campaign_id}:${e.creator_id}`} className="row between small"><span>@{e.handle} · {e.campaign}</span><button className="btn sm" onClick={() => void act(() => post(`/admin/creator-enrollments/${e.campaign_id}/${e.creator_id}/approve`), "اعتُمد الصانع", q.reload)}>اعتماد</button></div>)}
          </div>
        )}
      </section>)}
    </Loadable>
  );
}

function ContentPage() {
  const v = useQuery("/admin/moderation/videos");
  const cr = useQuery("/admin/creators");
  return (
    <>
      <PageHead title="المحتوى والصنّاع" sub="لا يظهر فيديو في اكتشف قبل الموافقة. حوافز الصنّاع اختيارية وتحتاج موافقة." />
      <CampaignsAdmin />
      <Loadable q={v}>{(d) => (
        <section className="panel stack" style={{ marginBottom: 20 }}>
          <h3>بانتظار المراجعة (<span className="num">{d.videos.length}</span>)</h3>
          {d.videos.length === 0 && <p className="muted small">لا شيء بانتظار المراجعة</p>}
          {d.videos.map((x: any) => (
            <div key={x.id} className="row" style={{ alignItems: "flex-start", gap: 16 }}>
              <video src={x.video_url} poster={x.poster_url ?? undefined} controls muted style={{ width: 120, height: 200, objectFit: "cover", borderRadius: 10, background: "var(--c-ink)" }} />
              <div className="grow stack" style={{ gap: 4 }}>
                <strong>{x.restaurant}</strong><span>{x.caption_ar}</span>
                <span className="small muted">{x.creator_handle ? `@${x.creator_handle}` : "رفعه المطعم"} · الأصناف: {(x.items ?? []).join("، ")}</span>
                <div className="row"><button className="btn sm primary" onClick={() => void act(() => post(`/admin/moderation/videos/${x.id}`, { decision: "approved" }), "تمت الموافقة", v.reload)}>موافقة</button>
                  <button className="btn sm danger" onClick={async () => { const reason = await askReason("يظهر السبب للناشر.", "سبب الرفض"); if (reason) void act(() => post(`/admin/moderation/videos/${x.id}`, { decision: "rejected", reason }), "تم الرفض", v.reload); }}>رفض</button></div>
              </div>
            </div>
          ))}
        </section>)}</Loadable>
      <Loadable q={cr}>{(d) => (
        <div className="cols">
          <section className="panel table-wrap"><h3>الصنّاع</h3><table className="table"><thead><tr><th>الحساب</th><th>طلبات منسوبة</th><th>الحالة</th><th /></tr></thead>
            <tbody>{d.creators.map((c: any) => <tr key={c.id}><td>@{c.handle}<div className="xs muted">{c.display_name}</div></td><td className="num">{c.attributed_orders}</td><td><StatusBadge s={c.status} /></td><td>{c.status !== "approved" ? <button className="btn sm" onClick={() => void act(() => post(`/admin/creators/${c.id}/status`, { status: "approved" }), "تم", cr.reload)}>اعتماد</button> : <button className="btn sm ghost" onClick={() => void act(() => post(`/admin/creators/${c.id}/status`, { status: "suspended" }), "تم", cr.reload)}>إيقاف</button>}</td></tr>)}</tbody></table></section>
          <section className="panel stack"><h3>حوافز الصنّاع</h3>{d.incentives.length === 0 && <p className="muted small">لا حوافز مسجلة. الحوافز تحتاج حملة فعّالة واشتراك الصانع وموافقتنا.</p>}{d.incentives.map((i: any) => <div key={i.id} className="row between small"><span>@{i.handle}</span><span className="num">{sar(i.amount)}</span><StatusBadge s={i.status} /></div>)}</section>
        </div>)}</Loadable>
    </>
  );
}

// ───────────────────────── finance ─────────────────────────
function Finance() {
  const tb = useQuery("/admin/ledger/trial-balance");
  const rec = useQuery("/admin/reconciliation");
  const je = useQuery("/admin/ledger/entries");
  return (
    <>
      <PageHead title="المالية" sub="دفتر قيد مزدوج غير قابل للتعديل. التصحيح بقيود عكسية فقط." />
      <Loadable q={rec}>{(r) => (
        <Kpis items={[
          { v: r.trialBalanced ? "متوازن" : "غير متوازن", l: "ميزان المراجعة", d: <>مدين <span className="num">{sar(r.trial.debit)}</span></> },
          { v: r.pspClearing.matches ? "مطابق" : "فرق", l: "بوابة الدفع مقابل الدفتر", d: <span className="num">{sar(r.pspClearing.ledgerBalance)}</span> },
          { v: <span className="num">{r.ordersMissingCaptureEntry.length}</span>, l: "طلبات بلا قيد تحصيل" },
          { v: <span className="num">{r.deliveriesMissingCostEntry.length}</span>, l: "توصيلات بلا قيد تكلفة" },
        ]} />)}</Loadable>
      <div className="cols">
        <Loadable q={tb}>{(d) => (
          <section className="panel table-wrap"><h3>أرصدة الحسابات</h3><table className="table"><thead><tr><th>الحساب</th><th>النوع</th><th>الرصيد</th></tr></thead>
            <tbody>{d.accounts.map((a: any) => <tr key={a.code}><td className="num" style={{ direction: "ltr", textAlign: "start" }}>{a.code}</td><td>{a.type}</td><td className="num">{sar(a.balance)}</td></tr>)}</tbody></table></section>)}</Loadable>
        <Loadable q={je}>{(d) => (
          <section className="panel stack"><h3>آخر القيود</h3>{d.entries.slice(0, 25).map((e: any) => (
            <details key={e.id} className="small"><summary><span className="num" style={{ direction: "ltr" }}>{e.event_type}</span> · {time(e.posted_at)}</summary>
              {e.lines.map((l: any, i: number) => <div key={i} className="row between xs"><span className="num" style={{ direction: "ltr" }}>{l.account}</span><span className="num">{l.debit ? `Dr ${sar(l.debit)}` : `Cr ${sar(l.credit)}`}</span></div>)}</details>))}</section>)}</Loadable>
      </div>
    </>
  );
}

function Settlements() {
  const q = useQuery("/admin/settlements");
  return (
    <>
      <PageHead title="التسويات" sub="المطاعم أسبوعياً، شركات التوصيل شهرياً. التحويل البنكي يُنفّذ يدوياً حالياً ويُسجل مرجعه." actions={<>
        <button className="btn sm" onClick={() => void act(() => post("/admin/settlements/generate", { partyType: "restaurant" }), "أُنشئت تسويات المطاعم", q.reload)}>إنشاء تسويات المطاعم (هذا الأسبوع)</button>
        <button className="btn sm" onClick={() => void act(() => post("/admin/settlements/generate", { partyType: "logistics" }), "أُنشئت تسويات التوصيل", q.reload)}>إنشاء تسويات التوصيل (هذا الشهر)</button>
      </>} />
      <Loadable q={q}>{(d) => d.settlements.length === 0 ? <Empty title="لا تسويات بعد" body="أنشئ تسويات الفترة الحالية من الأعلى." /> : (
        <div className="panel table-wrap"><table className="table"><thead><tr><th>الطرف</th><th>الفترة</th><th>الإجمالي</th><th>خصومات</th><th>محجوز (نزاع)</th><th>الصافي</th><th>الحالة</th><th /></tr></thead>
          <tbody>{d.settlements.map((s: any) => (
            <tr key={s.id}><td>{s.party_name}<div className="xs muted">{s.party_type === "restaurant" ? "مطعم" : "توصيل"}</div></td><td>{date(s.period_start)} – {date(s.period_end)}</td><td className="num">{sar(s.gross)}</td><td className="num">{sar(s.deductions)}</td><td className="num">{sar(s.withheld_disputed)}</td><td className="num"><strong>{sar(s.net_payable)}</strong></td><td><StatusBadge s={s.status} /></td>
              <td>{s.status === "draft" && <button className="btn sm" onClick={() => void act(() => post(`/admin/settlements/${s.id}/approve`), "اعتُمدت", q.reload)}>اعتماد</button>}
                {s.status === "approved" && <button className="btn sm primary" onClick={async () => { const ref = await ask({ title: "مرجع التحويل البنكي", label: "رقم مرجع التحويل من البنك (يُسجل في القيد والتدقيق).", minLength: 4 }); if (ref) void act(() => post(`/admin/settlements/${s.id}/paid`, { payoutRef: ref }), "سُجل الدفع", q.reload); }}>تسجيل الدفع</button>}</td></tr>))}</tbody></table></div>)}</Loadable>
    </>
  );
}

// ───────────────────────── growth: ABU9+, promotions ─────────────────────────
function Growth() {
  const s = useQuery("/admin/subscriptions");
  const p = useQuery("/admin/promotions");
  return (
    <>
      <PageHead title="أبو9+ والعروض" sub="أسعار أبو9+ أسعار اختبار وليست قراراً تجارياً نهائياً. لا تتجاوز أي حملة ميزانيتها المعتمدة." />
      <div className="stack lg">
        <Loadable q={s}>{(d) => (
          <section className="panel table-wrap"><h3>تجربة تسعير أبو9+</h3>
            <table className="table"><thead><tr><th>الخيار</th><th>المشتركون</th><th>فعّال</th><th>استخدامات الميزة</th><th>تكلفة الميزة</th><th>الوزن</th><th /></tr></thead>
              <tbody>{d.plusExperiment.map((v: any) => { const meta = d.plusVariants.find((x: any) => x.id === v.id); return (
                <tr key={v.id}><td className="num">{v.label}</td><td className="num">{v.subscribers}</td><td className="num">{v.active}</td><td className="num">{v.benefit_uses}</td><td className="num">{sar(v.benefit_cost)}</td><td className="num">{meta?.weight}</td>
                  <td><button className="btn sm" onClick={async () => { const w = await ask({ title: "وزن خيار السعر", label: "0 يوقف إسناد هذا الخيار للمشتركين الجدد.", kind: "number", initial: String(meta?.weight ?? 1), min: 0, max: 100 }); const reason = w !== null ? await askReason() : null; if (w !== null && reason) void act(() => patch(`/admin/plus-variants/${v.id}`, { weight: Number(w), reason }), "تم", s.reload); }}>تعديل الوزن</button></td></tr>); })}</tbody></table>
          </section>)}</Loadable>
        <Loadable q={p}>{(d) => (
          <section className="panel table-wrap"><h3>العروض <span className="small muted">· نقاط قائمة <span className="num">{d.pointsOutstanding.points}</span></span></h3>
            <table className="table"><thead><tr><th>الكود</th><th>المطعم</th><th>التمويل أبو9/مطعم</th><th>الصرف / الميزانية</th><th>الاستخدامات</th><th>الحالة</th><th /></tr></thead>
              <tbody>{d.promotions.map((x: any) => (
                <tr key={x.id}><td className="num">{x.code}<div className="xs muted">{x.title_ar}</div></td><td>{x.restaurant ?? "كل المطاعم"}</td><td className="num">{x.abu9_share_bps / 100}٪ / {x.restaurant_share_bps / 100}٪</td><td className="num">{sar(x.spent)} / {sar(x.budget)}</td><td className="num">{x.redemptions}</td><td><StatusBadge s={x.active ? "active" : "paused"} /></td>
                  <td><button className="btn sm" onClick={async () => { const reason = await askReason(); if (reason) void act(() => patch(`/admin/promotions/${x.id}`, { active: !x.active, reason }), "تم", p.reload); }}>{x.active ? "إيقاف" : "تفعيل"}</button></td></tr>))}</tbody></table>
            <h3 style={{ marginTop: 16 }}>حملات النقاط</h3>
            {d.loyaltyCampaigns.map((c: any) => <div key={c.id} className="small row between"><span>{c.name} · {c.restaurant}</span><span className="num">{sar(c.spent)} / {sar(c.budget)} · ×{c.multiplier}</span><StatusBadge s={c.status} /></div>)}
          </section>)}</Loadable>
      </div>
    </>
  );
}

// ───────────────────────── config: zones, coverage, pricing, batching ─────────────────────────
function Config() {
  const z = useQuery("/admin/zones");
  const s = useQuery("/admin/settings");
  const batching = s.data?.settings.find((x: any) => x.key === "batching")?.value;
  const editBatching = async () => {
    const det = await ask({ title: "أقصى انحراف للتجميع (كم)", kind: "number", initial: String(batching.maxDetourKm), min: 0, max: 10 });
    const del = det !== null ? await ask({ title: "أقصى تأخير مضاف (دقيقة)", kind: "number", initial: String(batching.maxAddedDelayMin), min: 0, max: 30 }) : null;
    const reason = del !== null ? await askReason() : null;
    if (det !== null && del !== null && reason) void act(() => put("/admin/settings/batching", { value: { ...batching, maxDetourKm: Number(det), maxAddedDelayMin: Number(del) }, reason }), "تم الحفظ", s.reload);
  };
  return (
    <>
      <PageHead title="المناطق والتسعير" sub="التغطية ديناميكية لكل فرع ومنطقة (مسافة الطريق، الوقت، السعة، الموعد، التكلفة) — لا يوجد نطاق موحّد." />
      <div className="stack lg">
        <Loadable q={z}>{(d) => (
          <>
            <section className="panel table-wrap"><h3>المناطق</h3>
              <table className="table"><thead><tr><th>المنطقة</th><th>الحالة</th><th>الموعد (دقيقة)</th><th /></tr></thead>
                <tbody>{d.zones.map((x: any) => <tr key={x.id}><td>{x.name_ar} <span className="num muted">{x.code}</span></td><td><StatusBadge s={x.status} /></td><td className="num">{x.sla_minutes}</td>
                  <td className="row" style={{ gap: 4 }}>{["active", "restricted", "paused"].filter((st) => st !== x.status).map((st) => <button key={st} className="btn sm" onClick={async () => { const reason = await askReason(); if (reason) void act(() => patch(`/admin/zones/${x.id}`, { status: st, reason }), "تم", z.reload); }}><StatusBadge s={st} /></button>)}</td></tr>)}</tbody></table>
            </section>
            <section className="panel table-wrap"><h3>قواعد التغطية لكل فرع</h3>
              <table className="table"><thead><tr><th>الفرع</th><th>المنطقة</th><th>أقصى مسافة طريق</th><th>أقصى وقت</th><th>مفعّلة</th></tr></thead>
                <tbody>{d.rules.map((r: any, i: number) => <tr key={i}><td>{r.restaurant} · {r.branch}</td><td className="num">{d.zones.find((x: any) => x.id === r.zone_id)?.code}</td><td className="num">{r.max_road_km} كم</td><td className="num">{r.max_travel_minutes} د</td><td>{r.enabled ? "نعم" : "لا"}</td></tr>)}</tbody></table>
            </section>
            <section className="panel stack"><h3>تسعير التوصيل (بإصدارات)</h3>
              {d.pricing.map((p: any) => <div key={p.id} className="small">{date(p.effective_from)} · {p.zone_id ? "منطقة محددة" : "افتراضي"}: أساسي <span className="num">{sar(p.basic_fee)}</span> لأول <span className="num">{p.base_distance_km}</span> كم، ثم <span className="num">{sar(p.additional_fee_per_increment)}</span> لكل <span className="num">{p.additional_increment_km}</span> كم (سقف <span className="num">{p.additional_fee_cap ? sar(p.additional_fee_cap) : "—"}</span>) · ضريبة <span className="num">{p.vat_rate_bps / 100}</span>٪</div>)}
              <p className="xs muted">إضافة إصدار جديد: POST /api/v1/admin/pricing (صلاحية المدير، تُسجّل في التدقيق).</p>
            </section>
          </>)}</Loadable>
        {batching && <section className="panel row between"><div><h3>التجميع</h3><p className="small">حتى <span className="num">2</span> طلبات للمندوب (ثابت) · انحراف <span className="num">{batching.maxDetourKm}</span> كم · تأخير <span className="num">{batching.maxAddedDelayMin}</span> د · لا نتجاوز أي موعد موعود.</p></div><button className="btn sm" onClick={editBatching}>تعديل</button></section>}
      </div>
    </>
  );
}

function RestaurantReview({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const q = useQuery(`/admin/restaurants/${id}/onboarding`);
  const zones = useQuery("/admin/zones");
  const STEP: Record<string, string> = { profile: "البيانات والسجل التجاري", branch: "الفروع", hours: "أوقات العمل", menu: "المنيو (٣ أصناف+)", terms: "الموافقة على الاتفاقية", coverage: "نطاق التوصيل (العمليات)" };
  const addCoverage = async (branchId: string) => {
    const zoneId = await ask({ title: "المنطقة", choices: (zones.data?.zones ?? []).map((z: any) => [z.id, `${z.name_ar} · ${z.code}`] as [string, string]) });
    if (!zoneId) return;
    const km = await ask({ title: "أقصى مسافة طريق (كم)", kind: "number", initial: "6", min: 0.5, max: 30 });
    if (km === null) return;
    const mins = await ask({ title: "أقصى زمن رحلة (دقيقة)", kind: "number", initial: "22", min: 5, max: 60 });
    if (mins === null) return;
    const reason = await askReason();
    if (reason) await act(() => put("/admin/coverage-rules", { branchId, zoneId, enabled: true, maxRoadKm: Number(km), maxTravelMinutes: Number(mins), reason }), "أُضيفت التغطية", q.reload);
  };
  return (
    <Sheet center label="مراجعة التهيئة" onClose={onClose}>
      <Loadable q={q}>
        {(d) => (
          <div className="stack">
            <h2>مراجعة التهيئة</h2>
            {d.steps.map((s: any) => <div key={s.key} className="row between small"><span>{STEP[s.key] ?? s.key}</span>{s.done ? <span className="badge ok">مكتمل</span> : <span className="badge warn">ناقص</span>}</div>)}
            <h3>الفروع</h3>
            {d.branches.map((b: any) => <div key={b.id} className="row between small"><span>{b.name_ar} · {b.district ?? "—"} <span className="num muted" dir="ltr">({b.lat.toFixed(4)}, {b.lng.toFixed(4)})</span></span><button className="btn sm" onClick={() => void addCoverage(b.id)}>+ تغطية</button></div>)}
            <p className="xs muted">التفعيل يبدأ الفترة التجريبية المجانية (30 يوماً) ويُظهر المطعم للعملاء داخل نطاق التغطية.</p>
            <button className="btn primary lg" disabled={!d.readyForActivation} onClick={async () => { const reason = await askReason("مثال: اكتمل التدريب ومراجعة المنيو."); if (reason) await act(() => post(`/admin/restaurants/${id}/activate`, { reason }), "تم التفعيل", onDone); }}>تفعيل المطعم</button>
          </div>
        )}
      </Loadable>
    </Sheet>
  );
}

function Partners() {
  const r = useQuery("/admin/restaurants");
  const c = useQuery("/admin/customers");
  const [review, setReview] = useState<string | null>(null);
  const setStatus = async (x: any, status: "active" | "suspended") => {
    const reason = await askReason(status === "suspended" ? "يختفي المطعم من الاكتشاف ولا يستقبل طلبات جديدة." : undefined, status === "suspended" ? `إيقاف ${x.name_ar}` : `إعادة تفعيل ${x.name_ar}`);
    if (reason) await act(() => post(`/admin/restaurants/${x.id}/status`, { status, reason }), "تم", r.reload);
  };
  return (
    <>
      <PageHead title="الشركاء والعملاء" />
      <div className="stack lg">
        <Loadable q={r}>{(d) => (<section className="panel table-wrap"><h3>المطاعم</h3><table className="table"><thead><tr><th>المطعم</th><th>الحالة</th><th>الباقة</th><th>الاشتراك</th><th>طلبات ٣٠ يوماً</th><th /></tr></thead><tbody>{d.restaurants.map((x: any) => <tr key={x.id}><td>{x.name_ar} {x.is_demo && <span className="demo-flag">تجريبي</span>}</td><td><StatusBadge s={x.status} /></td><td>{x.plan_code ?? "—"}</td><td>{x.sub_status ? <StatusBadge s={x.sub_status} /> : "—"}{x.sub_status === "trialing" && <div className="xs muted">حتى {date(x.trial_ends_at)}</div>}</td><td className="num">{x.orders_30d}</td><td>{x.status === "onboarding" ? <button className="btn sm primary" onClick={() => setReview(x.id)}>مراجعة</button> : x.status === "active" ? <button className="btn sm ghost" onClick={() => void setStatus(x, "suspended")}>إيقاف</button> : x.status === "suspended" ? <button className="btn sm" onClick={() => void setStatus(x, "active")}>إعادة تفعيل</button> : null}</td></tr>)}</tbody></table></section>)}</Loadable>
        {review && <RestaurantReview id={review} onClose={() => setReview(null)} onDone={() => { setReview(null); void r.reload(); }} />}
        <Loadable q={c}>{(d) => (<section className="panel table-wrap"><h3>العملاء</h3><table className="table"><thead><tr><th>الاسم</th><th>الجوال</th><th>الطلبات</th><th>أبو9+</th><th>الحالة</th></tr></thead><tbody>{d.customers.map((x: any) => <tr key={x.id}><td>{x.name ?? "—"}</td><td className="num">{x.phone}</td><td className="num">{x.orders}</td><td>{x.plus ? "نعم" : "—"}</td><td><StatusBadge s={x.status} /></td></tr>)}</tbody></table></section>)}</Loadable>
      </div>
    </>
  );
}

function Audit() {
  const q = useQuery("/admin/audit");
  return (
    <>
      <PageHead title="سجل التدقيق" sub="سجل غير قابل للتعديل أو الحذف (مفروض على مستوى قاعدة البيانات)." />
      <Loadable q={q}>{(d) => (
        <div className="panel table-wrap"><table className="table"><thead><tr><th>الوقت</th><th>المستخدم</th><th>الإجراء</th><th>الكيان</th><th>السبب</th></tr></thead>
          <tbody>{d.logs.map((l: any) => <tr key={l.id}><td className="num">{date(l.created_at)} {time(l.created_at)}</td><td>{l.actor_name ?? "النظام"}<div className="xs muted">{(l.actor_roles ?? []).join(", ")}</div></td><td className="num" style={{ direction: "ltr", textAlign: "start" }}>{l.action}</td><td className="xs">{l.entity_type}<div className="muted num">{l.entity_id?.slice(0, 8)}</div></td><td className="small">{l.reason}</td></tr>)}</tbody></table></div>)}</Loadable>
    </>
  );
}

mount(App);
