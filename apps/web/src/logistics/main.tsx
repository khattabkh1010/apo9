import { post } from "../shared/api.ts";
import { date, sar, time } from "../shared/i18n.ts";
import { ask, askReason, Brand, DashShell, Empty, Kpis, Loadable, OtpLogin, PageHead, StatusBadge, ToastHost, mount, toast, useHashRoute, useQuery, useSession } from "../shared/ui.tsx";

const DEMOS: Array<[string, string]> = [["مدير سهم للتوصيل", "0500000301"]];
const NAV: Array<[string, string]> = [["overview", "الأداء والالتزامات"], ["couriers", "المناديب"], ["jobs", "الرحلات"], ["capacity", "طلبات السعة"], ["settlements", "التسويات والمطالبات"]];
const WD = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

function App() {
  const authed = !!useSession();
  if (!authed) return (<><OtpLogin title={<span style={{ fontSize: 36 }}><Brand suffix="لشركاء التوصيل" /></span>} subtitle="إدارة المناديب والسعة والتسويات الشهرية." demoPhones={DEMOS} /><ToastHost /></>);
  return <Portal />;
}

function Portal() {
  const mine = useQuery("/logistics/mine");
  const [route] = useHashRoute("overview");
  return (
    <Loadable q={mine}>
      {(d) => {
        const c = d.companies[0];
        if (!c) return <Empty title="لا توجد شركة مرتبطة بحسابك" />;
        const base = route.split("/")[0];
        const page = base === "couriers" ? <Couriers cid={c.id} /> : base === "jobs" ? <Jobs cid={c.id} /> : base === "capacity" ? <Capacity cid={c.id} /> : base === "settlements" ? <Settlements cid={c.id} /> : <Overview cid={c.id} />;
        return <DashShell sub={c.name_ar} nav={NAV} route={route}>{page}</DashShell>;
      }}
    </Loadable>
  );
}

function Overview({ cid }: { cid: string }) {
  const q = useQuery(`/logistics/${cid}/overview`, { poll: 20_000 });
  return (
    <>
      <PageHead title="الأداء والالتزامات" sub="آخر ٧ أيام. أبو9 تتحكم بالتوزيع؛ الشريك مسؤول عن مناديبه ومركباته والتزاماته النظامية." />
      <Loadable q={q}>
        {(d) => (
          <>
            <Kpis items={[
              { v: <span className="num">{d.last7d.delivered}</span>, l: "توصيلات مكتملة", d: <><span className="num">{d.last7d.batched}</span> مجمّعة</> },
              { v: <span className="num">{d.last7d.onTimeRate === null ? "—" : `${Math.round(d.last7d.onTimeRate * 100)}٪`}</span>, l: "في الموعد (SLA)" },
              { v: <span className="num">{Math.round(d.last7d.avg_trip_min)}د</span>, l: "متوسط مدة الرحلة" },
              { v: <span className="num">{d.last7d.failed}</span>, l: "توصيلات فاشلة" },
              { v: <span className="num">{sar(d.last7d.accrued)}</span>, l: "مستحقات مسجلة" },
            ]} />
            <div className="cols">
              <section className="panel stack">
                <h3>العقد الحالي</h3>
                {d.contract ? (<div className="stack small">
                  <div className="row between"><span>لكل طلب مكتمل</span><span className="num">{sar(d.contract.per_order)}</span></div>
                  <div className="row between"><span>الطلب الثاني في رحلة مجمّعة</span><span className="num">{sar(d.contract.per_batched_order)}</span></div>
                  <div className="row between"><span>لكل كم بعد <span className="num">{d.contract.included_km}</span> كم</span><span className="num">{sar(d.contract.per_km_beyond)}</span></div>
                  <div className="row between"><span>حد أدنى بالساعة للسعة الملتزمة</span><span className="num">{sar(d.contract.committed_hourly_minimum)}</span></div>
                  <div className="row between"><span>مهلة الاعتراض</span><span className="num">{d.contract.dispute_window_hours} ساعة</span></div>
                </div>) : <p className="muted">لا يوجد عقد فعّال</p>}
              </section>
              <section className="panel stack">
                <h3>المناديب الآن</h3>
                {d.couriers.map((c: any) => <div key={c.status} className="row between"><StatusBadge s={c.status} /><span className="num">{c.n}</span></div>)}
                <hr className="rule" />
                {d.activeJobs.map((j: any) => <div key={j.status} className="row between small"><StatusBadge s={j.status} /><span className="num">{j.n}</span></div>)}
              </section>
              <section className="panel table-wrap">
                <h3>التزامات السعة الأساسية</h3>
                <table className="table"><thead><tr><th>اليوم</th><th>المنطقة</th><th>الساعات</th><th>المناديب</th></tr></thead>
                  <tbody>{d.commitments.slice(0, 14).map((c: any) => <tr key={c.id}><td>{WD[c.weekday]}</td><td>{c.zone_name}</td><td className="num">{c.start_hour}:00–{c.end_hour}:00</td><td className="num">{c.committed_couriers}</td></tr>)}</tbody></table>
              </section>
            </div>
          </>
        )}
      </Loadable>
    </>
  );
}

function Couriers({ cid }: { cid: string }) {
  const q = useQuery(`/logistics/${cid}/couriers`, { poll: 15_000 });
  return (
    <>
      <PageHead title="المناديب" sub="لإيقاف مندوب لديه رحلات جارية، اطلب من عمليات أبو9 إعادة إسنادها أولاً." />
      <Loadable q={q}>{(d) => (
        <div className="panel table-wrap"><table className="table"><thead><tr><th>المندوب</th><th>الجوال</th><th>المركبة</th><th>النوع</th><th>الحالة</th><th>الحمل</th><th>٧ أيام</th><th>التقييم</th><th /></tr></thead>
          <tbody>{d.couriers.map((c: any) => <tr key={c.id}><td>{c.display_name}</td><td className="num">{c.phone}</td><td>{c.vehicle_type}</td><td>{c.capacity_type === "committed" ? "ملتزمة" : "عند الطلب"}</td><td><StatusBadge s={c.status} /></td><td className="num">{c.load}/2</td><td className="num">{c.delivered_7d}</td><td className="num">{c.rating ?? "—"}</td>
            <td>{c.status !== "suspended" && <button className="btn sm danger" onClick={async () => { const reason = await askReason(); if (reason) await post(`/logistics/${cid}/couriers/${c.id}/status`, { status: "suspended", reason }).then(() => { toast("تم الإيقاف"); void q.reload(); }).catch((e) => toast(e.message, true)); }}>إيقاف</button>}</td></tr>)}</tbody></table></div>)}</Loadable>
    </>
  );
}

function Jobs({ cid }: { cid: string }) {
  const q = useQuery(`/logistics/${cid}/jobs`, { poll: 15_000 });
  return (
    <>
      <PageHead title="الرحلات" sub="كل طلب في رحلة مجمّعة يُحاسب بشكل مستقل." />
      <Loadable q={q}>{(d) => d.jobs.length === 0 ? <Empty title="لا رحلات بعد" /> : (
        <div className="panel table-wrap"><table className="table"><thead><tr><th>#</th><th>المندوب</th><th>المنطقة</th><th>الحالة</th><th>الإسناد</th><th>التسليم</th><th>في الموعد</th><th>كم</th><th>المستحق</th></tr></thead>
          <tbody>{d.jobs.map((j: any) => <tr key={j.id}><td className="num">{j.number}{j.batched && <span className="badge warn" style={{ marginInlineStart: 4 }}>مجمّع</span>}</td><td>{j.courier ?? "—"}</td><td className="num">{j.zone}</td><td><StatusBadge s={j.status} /></td><td className="num">{time(j.assigned_at)}</td><td className="num">{time(j.delivered_at)}</td><td>{j.delivered_at ? (j.on_time ? <span className="badge ok">نعم</span> : <span className="badge bad">لا</span>) : "—"}</td><td className="num">{Number(j.distance_km ?? 0).toFixed(1)}</td><td className="num">{j.compensation ? sar(j.compensation) : "—"}</td></tr>)}</tbody></table></div>)}</Loadable>
    </>
  );
}

function Capacity({ cid }: { cid: string }) {
  const q = useQuery(`/logistics/${cid}/capacity-requests`);
  return (
    <>
      <PageHead title="طلبات السعة في الذروة" sub="تطلب أبو9 مناديب إضافيين عند الحاجة؛ يمكنك القبول كلياً أو جزئياً أو الاعتذار." />
      <Loadable q={q}>{(d) => d.requests.length === 0 ? <Empty title="لا طلبات سعة حالياً" /> : (
        <div className="panel table-wrap"><table className="table"><thead><tr><th>المنطقة</th><th>الفترة</th><th>المطلوب</th><th>الملتزم</th><th>الحالة</th><th /></tr></thead>
          <tbody>{d.requests.map((r: any) => <tr key={r.id}><td>{r.zone_name}</td><td>{date(r.window_start)} {time(r.window_start)}–{time(r.window_end)}</td><td className="num">{r.requested_couriers}</td><td className="num">{r.committed_couriers ?? "—"}</td><td><StatusBadge s={r.status} /></td>
            <td>{r.status === "open" && <button className="btn sm primary" onClick={async () => { const n = await ask({ title: "الالتزام بالسعة", label: `المطلوب: ${r.requested_couriers} مندوب`, kind: "number", initial: String(r.requested_couriers), min: 0, max: 500 }); if (n !== null) await post(`/logistics/${cid}/capacity-requests/${r.id}/respond`, { committedCouriers: Number(n) }).then(() => q.reload()).catch((e) => toast(e.message, true)); }}>الرد</button>}</td></tr>)}</tbody></table></div>)}</Loadable>
    </>
  );
}

function Settlements({ cid }: { cid: string }) {
  const s = useQuery(`/logistics/${cid}/settlements`);
  const c = useQuery(`/logistics/${cid}/claims`);
  return (
    <>
      <PageHead title="التسويات والمطالبات" sub="تسوية شهرية حسب تقويم الرياض. لا خصم لمطالبة متنازع عليها." />
      <Loadable q={s}>{(d) => (<>
        <Kpis items={[{ v: <span className="num">{sar(d.currentPayable)}</span>, l: "المستحق لكم حالياً" }]} />
        <div className="panel table-wrap" style={{ marginBottom: 20 }}><table className="table"><thead><tr><th>الشهر</th><th>الرحلات</th><th>الإجمالي</th><th>الخصومات</th><th>محجوز</th><th>الصافي</th><th>الحالة</th></tr></thead>
          <tbody>{d.settlements.length === 0 && <tr><td colSpan={7} className="muted">لا تسويات بعد</td></tr>}{d.settlements.map((x: any) => <tr key={x.id}><td>{date(x.period_start)}</td><td className="num">{x.order_count}</td><td className="num">{sar(x.gross)}</td><td className="num">{sar(x.deductions)}</td><td className="num">{sar(x.withheld_disputed)}</td><td className="num"><strong>{sar(x.net_payable)}</strong></td><td><StatusBadge s={x.status} /></td></tr>)}</tbody></table></div></>)}</Loadable>
      <Loadable q={c}>{(d) => (
        <section className="panel stack"><h3>المطالبات</h3>{d.claims.length === 0 && <p className="muted small">لا مطالبات</p>}
          {d.claims.map((cl: any) => <div key={cl.id} className="row between small"><span>#<span className="num">{cl.number}</span> · {cl.reason_code} · <span className="num">{sar(cl.amount)}</span></span><span className="row" style={{ gap: 6 }}><StatusBadge s={cl.status} />{cl.status === "open" && <button className="btn sm" onClick={async () => { const note = await ask({ title: "الاعتراض على المطالبة", label: "اذكر السبب والدليل (سجل التتبع، وقت الوصول…).", kind: "textarea", minLength: 10 }); if (note) await post(`/logistics/${cid}/claims/${cl.id}/dispute`, { note }).then(() => c.reload()).catch((e) => toast(e.message, true)); }}>اعتراض</button>}</span></div>)}</section>)}</Loadable>
    </>
  );
}

mount(App);
