import { useEffect, useRef, useState } from "react";
import { patch, post } from "../shared/api.ts";
import { date, sar, time, minutesUntil } from "../shared/i18n.ts";
import { CreatorCampaigns } from "./campaigns.tsx";
import { Apply, HoursSheet, MenuToolbar, ModifiersSheet, Onboarding } from "./onboarding.tsx";
import { ask, DashShell, Empty, Kpis, Loadable, OtpLogin, PageHead, Brand, Sheet, StatusBadge, ToastHost, mount, toast, useHashRoute, useQuery, useSession } from "../shared/ui.tsx";

const DEMOS: Array<[string, string]> = [["مالك برجر نجد", "0500000101"], ["مالك مشاوي الديرة", "0500000102"]];
const NAV: Array<[string, string]> = [["orders", "الطلبات الحية"], ["menu", "المنيو والتوفر"], ["analytics", "الأداء"], ["content", "الفيديوهات"], ["promotions", "العروض"], ["billing", "الباقة والفواتير"], ["settlements", "التسويات والمطالبات"]];

function App() {
  const authed = !!useSession();
  if (!authed) return (<><OtpLogin title={<span style={{ fontSize: 36 }}><Brand suffix="للمطاعم" /></span>} subtitle="إدارة الطلبات والمنيو والتسويات لمطعمك." demoPhones={DEMOS} /><ToastHost /></>);
  return <Portal />;
}

function Portal() {
  const mine = useQuery("/restaurant/mine");
  const [route, go] = useHashRoute("orders");
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <Loadable q={mine}>
      {(d) => {
        const r = d.restaurants.find((x: any) => x.id === picked) ?? d.restaurants[0];
        if (!r) return (<><Apply onDone={() => void mine.reload()} /><ToastHost /></>);
        const onboarding = r.status === "onboarding";
        const nav: Array<[string, string]> = onboarding ? [["onboarding", "التهيئة"], ...NAV] : [...NAV, ["onboarding", "بيانات المطعم"]];
        const base = route.split("/")[0] === "orders" && onboarding && !location.hash ? "onboarding" : route.split("/")[0];
        const foot = (
          <>
            {d.restaurants.length > 1 && (
              <select className="input" aria-label="المطعم" value={r.id} onChange={(e) => setPicked(e.target.value)}>
                {d.restaurants.map((x: any) => <option key={x.id} value={x.id}>{x.name_ar}</option>)}
              </select>
            )}
            {onboarding && <span className="badge warn">قيد التهيئة</span>}
            {r.is_demo && <span className="demo-flag">بيانات تجريبية</span>}
          </>
        );
        return (
          <DashShell sub={r.name_ar} nav={nav} route={base === "onboarding" ? "onboarding" : route} foot={foot}>
            {base === "onboarding" ? <Onboarding rid={r.id} go={go} /> : base === "menu" ? <Menu rid={r.id} /> : base === "analytics" ? <Analytics rid={r.id} /> : base === "content" ? <Content rid={r.id} /> : base === "promotions" ? <Promotions rid={r.id} /> : base === "billing" ? <Billing rid={r.id} /> : base === "settlements" ? <Settlements rid={r.id} /> : <Orders rid={r.id} />}
          </DashShell>
        );
      }}
    </Loadable>
  );
}

// ───────────────────────── live orders (kitchen queue) ─────────────────────────
function Orders({ rid }: { rid: string }) {
  const q = useQuery(`/restaurant/${rid}/orders`, { poll: 5_000 });
  const [accepting, setAccepting] = useState<any>(null);
  const seen = useRef<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const placed = (q.data?.orders ?? []).filter((o: any) => o.status === "placed").map((o: any) => o.id);
    const nw = placed.filter((id: string) => !seen.current.has(id));
    if (seen.current.size && nw.length) {
      toast(`طلب جديد (${nw.length})`);
      try { new AudioContext().resume(); } catch { /* sound cue is best-effort */ }
    }
    placed.forEach((id: string) => seen.current.add(id));
    setFresh(new Set(nw));
  }, [q.data]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok); await q.reload(); } catch (e) { toast((e as Error).message, true); }
  };
  const lanes: Array<[string, string, string[]]> = [["new", "جديدة", ["placed"]], ["prep", "قيد التحضير", ["accepted", "preparing"]], ["ready", "جاهزة للاستلام", ["ready_for_pickup"]]];
  return (
    <>
      <PageHead title="الطلبات الحية" sub="تتحدث تلقائياً كل ٥ ثوانٍ. الطلبات غير المقبولة خلال ٤ دقائق تُلغى تلقائياً ولا يُخصم من العميل." />
      <Loadable q={q}>
        {(d) => (
          <div className="board">
            {lanes.map(([k, title, statuses]) => {
              const list = d.orders.filter((o: any) => statuses.includes(o.status));
              return (
                <section className="lane" key={k} aria-label={title}>
                  <h3><span>{title}</span><span className="num">{list.length}</span></h3>
                  {list.length === 0 && <p className="small muted" style={{ padding: 6 }}>لا شيء هنا</p>}
                  {list.map((o: any) => {
                    const waiting = o.status === "placed" ? Math.max(0, Math.round((Date.now() - new Date(o.placed_at).getTime()) / 60000)) : null;
                    const late = (minutesUntil(o.ready_at) ?? 1) < 0 && o.status !== "ready_for_pickup";
                    return (
                      <article key={o.id} className={`ticket ${fresh.has(o.id) ? "new" : ""} ${late ? "late" : ""}`}>
                        <div className="row between"><strong>#<span className="num">{o.number}</span></strong><span className="xs muted">{o.branch_name} · {time(o.created_at)}</span></div>
                        <ul className="small" style={{ margin: "8px 0", paddingInlineStart: 18 }}>
                          {o.items.map((i: any, n: number) => (
                            <li key={n}><span className="num">{i.qty}×</span> {i.nameAr}{i.options?.length ? <span className="muted"> ({i.options.map((x: any) => x.nameAr).join("، ")})</span> : null}</li>
                          ))}
                        </ul>
                        {o.notes && <p className="notice small">{o.notes}</p>}
                        <div className="row between xs muted" style={{ marginTop: 8 }}>
                          <span className="num">{sar(o.food_subtotal)}</span>
                          {waiting !== null && <span className={waiting >= 2 ? "error-text" : ""}>ينتظر منذ <span className="num">{waiting}</span> د</span>}
                          {o.ready_at && o.status !== "placed" && <span>الجاهزية {time(o.ready_at)}</span>}
                        </div>
                        {o.delivery && o.status !== "placed" && (
                          <div className="row between small" style={{ marginTop: 8, padding: "8px 10px", background: "var(--c-mist)", borderRadius: 8 }}>
                            <span>{o.delivery.courierName ? `المندوب: ${o.delivery.courierName}` : "جارٍ تعيين مندوب"}</span>
                            <span>رمز الاستلام <strong className="num">{o.delivery.pickupCode}</strong></span>
                          </div>
                        )}
                        <div className="row" style={{ marginTop: 10 }}>
                          {o.status === "placed" && (<>
                            <button className="btn primary grow" onClick={() => setAccepting(o)}>قبول</button>
                            <button className="btn danger" onClick={async () => { const reason = await ask({ title: "سبب رفض الطلب", label: "يُبلّغ العميل ويُسترد المبلغ كاملاً.", choices: [["too_busy", "ضغط عالٍ في المطبخ"], ["item_unavailable", "صنف غير متوفر"], ["closing", "قرب الإغلاق"], ["other", "سبب آخر"]], confirmLabel: "رفض الطلب", danger: true }); if (reason) void act(() => post(`/restaurant/${rid}/orders/${o.id}/reject`, { reason }), "تم رفض الطلب"); }}>رفض</button>
                          </>)}
                          {(o.status === "preparing" || o.status === "accepted") && <button className="btn dark grow" onClick={() => void act(() => post(`/restaurant/${rid}/orders/${o.id}/ready`), "الطلب جاهز")}>الطلب جاهز</button>}
                          {o.status === "ready_for_pickup" && <StatusBadge s={o.delivery?.status ?? "ready_for_pickup"} />}
                        </div>
                      </article>
                    );
                  })}
                </section>
              );
            })}
          </div>
        )}
      </Loadable>
      {accepting && <AcceptSheet o={accepting} onClose={() => setAccepting(null)} onAccept={(m) => { setAccepting(null); void act(() => post(`/restaurant/${rid}/orders/${accepting.id}/accept`, { prepMinutes: m }), "تم القبول — جارٍ تعيين مندوب"); }} />}
    </>
  );
}

function AcceptSheet({ o, onClose, onAccept }: { o: any; onClose: () => void; onAccept: (m: number) => void }) {
  const [m, setM] = useState(o.prep_minutes ?? 15);
  return (
    <Sheet onClose={onClose} label="قبول الطلب" center>
      <div className="stack lg">
        <h2>كم يحتاج الطلب #<span className="num">{o.number}</span> للتحضير؟</h2>
        <div className="chips">{[8, 10, 12, 15, 20, 25, 30].map((x) => <button key={x} className="chip" aria-pressed={m === x} onClick={() => setM(x)}><span className="num">{x}</span> د</button>)}</div>
        <p className="small muted">نرسل المندوب ليصل وقت جاهزية الطلب تقريباً، فلا ينتظر الأكل ولا ينتظر المندوب.</p>
        <button className="btn primary lg" onClick={() => onAccept(m)}>قبول · جاهز خلال <span className="num">{m}</span> دقيقة</button>
      </div>
    </Sheet>
  );
}

// ───────────────────────── menu & availability ─────────────────────────
function Menu({ rid }: { rid: string }) {
  const q = useQuery(`/restaurant/${rid}/menu`);
  const [editing, setEditing] = useState<any>(null);
  const [mods, setMods] = useState<any>(null);
  const [hours, setHours] = useState<any>(null);
  const toggle = async (it: any) => {
    try { await patch(`/restaurant/${rid}/menu/items/${it.id}`, { isAvailable: !it.is_available }); await q.reload(); } catch (e) { toast((e as Error).message, true); }
  };
  const branchToggle = async (b: any) => {
    try { await patch(`/restaurant/${rid}/branches/${b.id}`, { acceptingOrders: !b.accepting_orders }); await q.reload(); toast(b.accepting_orders ? "أوقفنا استقبال الطلبات للفرع" : "الفرع يستقبل الطلبات"); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <>
      <PageHead title="المنيو والتوفر" sub="تغييرات الأسعار والتوفر تُسجّل في سجل التدقيق." actions={q.data ? <MenuToolbar rid={rid} categories={q.data.categories} onChanged={() => void q.reload()} /> : undefined} />
      <Loadable q={q}>
        {(d) => (
          <div className="stack lg">
            <section className="panel stack">
              <h3>الفروع</h3>
              {d.branches.map((b: any) => (
                <div key={b.id} className="row between">
                  <span>{b.name_ar} · تحضير افتراضي <span className="num">{b.prep_minutes_default}</span> د{Object.values(b.opening_hours ?? {}).some((x: any) => x.length) ? "" : <span className="badge warn" style={{ marginInlineStart: 8 }}>بدون أوقات عمل</span>}</span>
                  <span className="row" style={{ gap: 6 }}>
                    <button className="btn sm ghost" onClick={() => setHours(b)}>أوقات العمل</button>
                    <button className={`btn sm ${b.accepting_orders ? "" : "primary"}`} onClick={() => void branchToggle(b)}>{b.accepting_orders ? "إيقاف مؤقت" : "استئناف الطلبات"}</button>
                  </span>
                </div>
              ))}
            </section>
            {d.categories.length === 0 && <Empty title="المنيو فارغ" body="ابدأ بإضافة قسم (مثل «الأطباق الرئيسية») ثم أضف الأصناف وأسعارها." />}
            {d.categories.map((c: any) => (
              <section key={c.id} className="panel stack">
                <h3>{c.name_ar}</h3>
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>الصنف</th><th>السعر</th><th>الحالة</th><th /></tr></thead>
                  <tbody>
                    {d.items.filter((i: any) => i.category_id === c.id).map((i: any) => (
                      <tr key={i.id}>
                        <td><strong>{i.name_ar}</strong><div className="xs muted">{i.name_en}</div></td>
                        <td className="num">{sar(i.price)}</td>
                        <td>{i.is_available ? <span className="badge ok">متوفر</span> : <span className="badge bad">نفد</span>}</td>
                        <td className="row" style={{ justifyContent: "flex-end" }}>
                          <button className="btn sm" onClick={() => void toggle(i)}>{i.is_available ? "نفد" : "متوفر"}</button>
                          <button className="btn sm ghost" onClick={() => setMods(i)}>الخيارات</button>
                          <button className="btn sm ghost" onClick={() => setEditing(i)}>تعديل</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              </section>
            ))}
          </div>
        )}
      </Loadable>
      {editing && <EditItem rid={rid} item={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void q.reload(); }} />}
      {mods && <ModifiersSheet rid={rid} item={mods} onClose={() => setMods(null)} />}
      {hours && <HoursSheet rid={rid} branch={hours} onClose={() => setHours(null)} onSaved={() => { setHours(null); void q.reload(); }} />}
    </>
  );
}

function EditItem({ rid, item, onClose, onSaved }: { rid: string; item: any; onClose: () => void; onSaved: () => void }) {
  const [nameAr, setNameAr] = useState(item.name_ar);
  const [price, setPrice] = useState((item.price / 100).toString());
  const [desc, setDesc] = useState(item.description_ar ?? "");
  return (
    <Sheet onClose={onClose} label="تعديل الصنف" center>
      <form className="stack lg" onSubmit={async (e) => {
        e.preventDefault();
        try { await patch(`/restaurant/${rid}/menu/items/${item.id}`, { nameAr, price: Math.round(Number(price) * 100), descriptionAr: desc }); toast("تم الحفظ"); onSaved(); } catch (er) { toast((er as Error).message, true); }
      }}>
        <h2>تعديل {item.name_ar}</h2>
        <div className="field"><label htmlFor="n">الاسم</label><input id="n" className="input" value={nameAr} onChange={(e) => setNameAr(e.target.value)} /></div>
        <div className="field"><label htmlFor="p">السعر شامل الضريبة (ر.س)</label><input id="p" className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
        <div className="field"><label htmlFor="d">الوصف</label><textarea id="d" className="input" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
        <button className="btn primary lg">حفظ التغييرات</button>
      </form>
    </Sheet>
  );
}

// ───────────────────────── analytics ─────────────────────────
function Analytics({ rid }: { rid: string }) {
  const q = useQuery(`/restaurant/${rid}/analytics?days=14`);
  return (
    <>
      <PageHead title="الأداء" sub="آخر ١٤ يوماً. المبيعات = قيمة الطعام بعد الخصومات، وتُحوّل لك بالكامل — لا عمولة على السلة." />
      <Loadable q={q}>
        {(d) => {
          const max = Math.max(1, ...d.daily.map((x: any) => Number(x.sales)));
          return (
            <>
              <Kpis items={[
                { v: <span className="num">{sar(d.totals.sales)}</span>, l: "مبيعات الطعام" },
                { v: <span className="num">{d.totals.delivered}</span>, l: "طلبات مكتملة", d: <>من <span className="num">{d.totals.total}</span> طلب</> },
                { v: <span className="num">{Math.round(d.totals.avg_accept_seconds)}ث</span>, l: "متوسط وقت القبول" },
                { v: <span className="num">{Math.round(d.totals.avg_prep_planned)}د</span>, l: "متوسط وقت التحضير" },
              ]} />
              <div className="cols">
                <section className="panel stack">
                  <h3>المبيعات اليومية</h3>
                  {d.daily.length === 0 ? <p className="muted small">لا بيانات بعد</p> : (
                    <div className="bars" role="img" aria-label="رسم المبيعات اليومية">
                      {d.daily.map((x: any) => <div key={x.day} style={{ height: `${(Number(x.sales) / max) * 100}%` }} data-v={`${x.day}: ${sar(x.sales)}`} />)}
                    </div>
                  )}
                </section>
                <section className="panel stack">
                  <h3>الأكثر طلباً</h3>
                  {d.topItems.length === 0 ? <p className="muted small">لا بيانات بعد</p> : d.topItems.map((t: any) => <div key={t.name_ar} className="row between small"><span>{t.name_ar}</span><span className="num">{t.qty}</span></div>)}
                </section>
              </div>
            </>
          );
        }}
      </Loadable>
    </>
  );
}

// ───────────────────────── content ─────────────────────────
function Content({ rid }: { rid: string }) {
  const q = useQuery(`/restaurant/${rid}/videos`);
  return (
    <>
      <PageHead title="الفيديوهات" sub="كل فيديو يمر بمراجعة المحتوى قبل ظهوره في اكتشف، ويجب ربطه بأصناف من منيوك." />
      <Loadable q={q}>
        {(d) => (
          <div className="panel table-wrap">
            <table className="table">
              <thead><tr><th /><th>الوصف</th><th>صانع المحتوى</th><th>المشاهدات</th><th>الإعجابات</th><th>الحالة</th></tr></thead>
              <tbody>
                {d.videos.map((v: any) => (
                  <tr key={v.id}>
                    <td>{v.poster_url ? <img src={v.poster_url} alt="" style={{ width: 40, height: 64, objectFit: "cover", borderRadius: 6 }} /> : null}</td>
                    <td>{v.caption_ar}{v.rejection_reason && <div className="xs error-text">{v.rejection_reason}</div>}</td>
                    <td>{v.creator_handle ? `@${v.creator_handle}` : "المطعم"}</td>
                    <td className="num">{v.view_count}</td>
                    <td className="num">{v.like_count}</td>
                    <td><StatusBadge s={v.status} /></td>
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

// ───────────────────────── promotions ─────────────────────────
function Promotions({ rid }: { rid: string }) {
  const q = useQuery(`/restaurant/${rid}/promotions`);
  const [form, setForm] = useState({ code: "", titleAr: "", kind: "percent", value: "10", minFood: "30", budget: "500", days: "14" });
  const create = async () => {
    try {
      await post(`/restaurant/${rid}/promotions`, { code: form.code, titleAr: form.titleAr, kind: form.kind, value: form.kind === "percent" ? Number(form.value) * 100 : Math.round(Number(form.value) * 100), minFoodSubtotal: Math.round(Number(form.minFood) * 100), budget: Math.round(Number(form.budget) * 100), days: Number(form.days) });
      toast("تم إنشاء العرض");
      await q.reload();
    } catch (e) { toast((e as Error).message, true); }
  };
  const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: any) => setForm({ ...form, [k]: e.target.value }) });
  return (
    <>
      <PageHead title="العروض" sub="العروض الممولة منك بالكامل تُفعّل مباشرة. العروض المشتركة مع أبو9 تحتاج موافقة. لا يتجاوز أي عرض ميزانيته." />
      <div className="cols">
        <section className="panel stack">
          <h3>عرض جديد</h3>
          <div className="field"><label>الكود</label><input className="input num" placeholder="NAJD15" {...f("code")} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} /></div>
          <div className="field"><label>العنوان للعميل</label><input className="input" {...f("titleAr")} /></div>
          <div className="row">
            <div className="field grow"><label>النوع</label><select className="input" {...f("kind")}><option value="percent">نسبة ٪</option><option value="fixed">مبلغ ثابت</option></select></div>
            <div className="field grow"><label>القيمة</label><input className="input num" {...f("value")} /></div>
          </div>
          <div className="row">
            <div className="field grow"><label>حد أدنى (ر.س)</label><input className="input num" {...f("minFood")} /></div>
            <div className="field grow"><label>الميزانية (ر.س)</label><input className="input num" {...f("budget")} /></div>
            <div className="field grow"><label>المدة (أيام)</label><input className="input num" {...f("days")} /></div>
          </div>
          <button className="btn primary" disabled={!form.code || !form.titleAr} onClick={() => void create()}>إنشاء العرض</button>
        </section>
        <Loadable q={q}>
          {(d) => (
            <section className="panel stack">
              <h3>العروض الحالية</h3>
              {d.promotions.length === 0 && <p className="muted small">لا عروض بعد</p>}
              {d.promotions.map((p: any) => (
                <div key={p.id} className="stack" style={{ gap: 4, paddingBottom: 10, borderBottom: "1px solid var(--c-line)" }}>
                  <div className="row between"><strong className="num">{p.code}</strong><span className={`badge ${p.active ? "ok" : ""}`}>{p.active ? "فعّال" : "متوقف"}</span></div>
                  <span className="small">{p.title_ar}</span>
                  <span className="xs muted">الصرف <span className="num">{sar(p.spent)}</span> من <span className="num">{sar(p.budget)}</span> · تمويلك <span className="num">{p.restaurant_share_bps / 100}</span>٪</span>
                </div>
              ))}
              <h3 style={{ marginTop: 10 }}>حملات النقاط</h3>
              {d.loyaltyCampaigns.map((c: any) => (
                <div key={c.id} className="small">{c.name} · <span className="num">×{c.multiplier}</span> · الصرف <span className="num">{sar(c.spent)}</span>/<span className="num">{sar(c.budget)}</span> · حصتك <span className="num">{c.restaurant_share_bps / 100}</span>٪</div>
              ))}
            </section>
          )}
        </Loadable>
      </div>
      <CreatorCampaigns rid={rid} />
    </>
  );
}

// ───────────────────────── billing ─────────────────────────
function Billing({ rid }: { rid: string }) {
  const q = useQuery(`/restaurant/${rid}/subscription`);
  return (
    <>
      <PageHead title="الباقة والفواتير" sub="اشتراك شهري ثابت حسب حجم الطلبات — بدون نسبة من قيمة السلة. التسجيل وإعداد المنيو والتدريب مجاناً." />
      <Loadable q={q}>
        {(d) => {
          const s = d.subscription;
          const plan = d.plans.find((p: any) => p.code === s?.plan_code);
          return (
            <div className="stack lg">
              <Kpis items={[
                { v: plan?.nameAr ?? "—", l: "الباقة الحالية", d: s?.status === "trialing" ? <>تجربة مجانية حتى {date(s.trial_ends_at)}</> : <>تتجدد {date(s?.current_period_end)}</> },
                { v: <span className="num">{d.ordersThisCycle}</span>, l: "طلبات هذه الدورة", d: plan?.maxOrders ? <>حد الباقة <span className="num">{plan.maxOrders}</span></> : undefined },
              ]} />
              {d.proposals.filter((p: any) => p.status === "pending").map((p: any) => (
                <section key={p.id} className="notice stack">
                  <strong>اقتراح تغيير الباقة إلى {d.plans.find((x: any) => x.code === p.to_plan)?.nameAr} عند التجديد ({date(p.effective_at)})</strong>
                  <span className="small">لن يتغير شيء بدون موافقتك، ولا توجد رسوم في منتصف الدورة.</span>
                  <div className="row">
                    <button className="btn primary sm" onClick={async () => { await post(`/restaurant/${rid}/plan-proposals/${p.id}/decision`, { accept: true }).then(() => q.reload()).catch((e) => toast(e.message, true)); }}>موافق</button>
                    <button className="btn sm" onClick={async () => { await post(`/restaurant/${rid}/plan-proposals/${p.id}/decision`, { accept: false }).then(() => q.reload()).catch((e) => toast(e.message, true)); }}>لا، شكراً</button>
                  </div>
                </section>
              ))}
              <section className="panel table-wrap">
                <table className="table">
                  <thead><tr><th>الباقة</th><th>الطلبات شهرياً</th><th>السعر الشهري</th></tr></thead>
                  <tbody>
                    {d.plans.map((p: any) => (
                      <tr key={p.code} style={p.code === s?.plan_code ? { background: "var(--c-warnSoft)" } : undefined}>
                        <td><strong>{p.nameAr}</strong></td>
                        <td className="num">{p.maxOrders ? `${p.minOrders}–${p.maxOrders}` : `${p.minOrders}+`}</td>
                        <td className="num">{p.monthlyPrice ? sar(p.monthlyPrice) : "حسب الاتفاق"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="xs muted" style={{ marginTop: 8 }}>{d.notes.join(" ")} الأسعار لا تشمل ضريبة القيمة المضافة.</p>
              </section>
              {d.invoices.length > 0 && (
                <section className="panel table-wrap"><h3>الفواتير</h3><table className="table"><tbody>{d.invoices.map((i: any) => <tr key={i.id}><td>{date(i.period_start)} – {date(i.period_end)}</td><td>{i.plan_code}</td><td className="num">{sar(i.amount)}</td><td><StatusBadge s={i.status === "open" ? "open" : "paid"} /></td></tr>)}</tbody></table></section>
              )}
            </div>
          );
        }}
      </Loadable>
    </>
  );
}

// ───────────────────────── settlements & claims ─────────────────────────
function Settlements({ rid }: { rid: string }) {
  const s = useQuery(`/restaurant/${rid}/settlements`);
  const c = useQuery(`/restaurant/${rid}/claims`);
  return (
    <>
      <PageHead title="التسويات والمطالبات" sub="تسوية أسبوعية (الأحد–السبت بتوقيت الرياض). المبالغ غير المتنازع عليها لا تُحجز." />
      <Loadable q={s}>
        {(d) => (
          <>
            <Kpis items={[{ v: <span className="num">{sar(d.currentPayable)}</span>, l: "المستحق لك حالياً" }]} />
            <section className="panel table-wrap" style={{ marginBottom: 20 }}>
              <table className="table">
                <thead><tr><th>الفترة</th><th>الطلبات</th><th>الإجمالي</th><th>الخصومات</th><th>محجوز (متنازع عليه)</th><th>الصافي</th><th>الحالة</th></tr></thead>
                <tbody>
                  {d.settlements.length === 0 && <tr><td colSpan={7} className="muted">لا تسويات بعد</td></tr>}
                  {d.settlements.map((x: any) => (
                    <tr key={x.id}><td>{date(x.period_start)} – {date(x.period_end)}</td><td className="num">{x.order_count}</td><td className="num">{sar(x.gross)}</td><td className="num">{sar(x.deductions)}</td><td className="num">{sar(x.withheld_disputed)}</td><td className="num"><strong>{sar(x.net_payable)}</strong></td><td><StatusBadge s={x.status} /></td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </Loadable>
      <Loadable q={c}>
        {(d) => (
          <section className="panel stack">
            <h3>مطالبات التعويض</h3>
            <p className="small muted">عندما تعوّض أبو9 عميلاً بسبب يُنسب للمطعم، تُفتح مطالبة. يمكنك الاعتراض قبل انتهاء المهلة، ولا يُخصم شيء قبل ذلك أو أثناء الاعتراض.</p>
            {d.claims.length === 0 && <p className="muted small">لا مطالبات</p>}
            {d.claims.map((cl: any) => (
              <div key={cl.id} className="row between small" style={{ padding: "8px 0", borderBottom: "1px solid var(--c-line)" }}>
                <span>#<span className="num">{cl.number}</span> · {cl.reason_code} · <span className="num">{sar(cl.amount)}</span>{cl.deductible_after && <span className="muted"> · المهلة حتى {date(cl.deductible_after)} {time(cl.deductible_after)}</span>}</span>
                <span className="row" style={{ gap: 8 }}>
                  <StatusBadge s={cl.status} />
                  {cl.status === "open" && <button className="btn sm" onClick={async () => { const note = await ask({ title: "الاعتراض على المطالبة", label: "اذكر السبب والدليل (رقم الفاتورة، وقت التجهيز…).", kind: "textarea", minLength: 10 }); if (note) await post(`/restaurant/${rid}/claims/${cl.id}/dispute`, { note }).then(() => c.reload()).catch((e) => toast(e.message, true)); }}>اعتراض</button>}
                </span>
              </div>
            ))}
          </section>
        )}
      </Loadable>
    </>
  );
}

mount(App);
