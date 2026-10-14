import { useState } from "react";
import { get, post, session } from "../shared/api.ts";
import { sar, date } from "../shared/i18n.ts";
import { Brand, DashShell, Empty, Kpis, Loadable, OtpLogin, PageHead, StatusBadge, ToastHost, mount, toast, useHashRoute, useQuery, useSession } from "../shared/ui.tsx";

const DEMOS: Array<[string, string]> = [["نورة (صانعة محتوى)", "0500000401"]];
const NAV: Array<[string, string]> = [["overview", "الأداء"], ["upload", "رفع فيديو"], ["campaigns", "الحملات"]];

function App() {
  const authed = !!useSession();
  const [route] = useHashRoute("overview");
  if (!authed) return (<><OtpLogin title={<span style={{ fontSize: 36 }}><Brand suffix="لصنّاع المحتوى" /></span>} subtitle="انشر فيديوهات الأكل، اربطها بالأطباق، وتابع الطلبات المنسوبة لك." demoPhones={DEMOS} /><ToastHost /></>);
  const base = route.split("/")[0];
  return <DashShell sub="بوابة صنّاع المحتوى" nav={NAV} route={route}>{base === "upload" ? <Upload /> : base === "campaigns" ? <Campaigns /> : <Overview />}</DashShell>;
}

function Overview() {
  const q = useQuery("/creator/me");
  const [code, setCode] = useState("");
  return (
    <>
      <PageHead title="الأداء" sub={q.data?.attributionModel} />
      <Loadable q={q}>
        {(d) => (
          <>
            {d.creator.status !== "approved" && <div className="notice" style={{ marginBottom: 16 }}>حسابك قيد المراجعة. ستتمكن من النشر بعد الاعتماد.</div>}
            <Kpis items={[
              { v: <span className="num">{d.stats.views}</span>, l: "مشاهدات" },
              { v: <span className="num">{d.stats.likes}</span>, l: "إعجابات" },
              { v: <span className="num">{d.stats.orders}</span>, l: "طلبات منسوبة لك" },
              { v: <span className="num">{sar(d.stats.attributed_food_value)}</span>, l: "قيمة الطعام المنسوبة" },
            ]} />
            <div className="cols">
              <section className="panel stack">
                <h3>أكواد الإحالة</h3>
                {d.referralCodes.map((c: any) => <div key={c.code} className="row between"><strong className="num">{c.code}</strong><span className="small muted"><span className="num">{c.uses}</span> استخدام</span></div>)}
                <div className="row">
                  <input className="input num grow" placeholder="NOURA20" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} aria-label="كود جديد" />
                  <button className="btn" disabled={code.length < 4} onClick={async () => { await post("/creator/referral-codes", { code }).then(() => { setCode(""); void q.reload(); }).catch((e) => toast(e.message, true)); }}>إنشاء</button>
                </div>
              </section>
              <section className="panel stack">
                <h3>الحوافز</h3>
                {d.incentives.length === 0 ? <p className="small muted">لا حوافز بعد. الحوافز تُحتسب فقط ضمن حملات اشتركت فيها ووافقت عليها أبو9.</p> : d.incentives.map((i: any) => <div key={i.id} className="row between small"><span>{i.campaign}</span><span className="num">{sar(i.amount)}</span><StatusBadge s={i.status} /></div>)}
              </section>
            </div>
            <section className="panel table-wrap" style={{ marginTop: 20 }}>
              <h3>فيديوهاتي</h3>
              {d.videos.length === 0 ? <Empty title="لم تنشر بعد" body="ارفع أول فيديو واربطه بطبق." /> : (
                <table className="table"><thead><tr><th /><th>المطعم</th><th>الوصف</th><th>مشاهدات</th><th>طلبات</th><th>الحالة</th></tr></thead>
                  <tbody>{d.videos.map((v: any) => <tr key={v.id}><td>{v.poster_url && <img src={v.poster_url} alt="" style={{ width: 40, height: 64, objectFit: "cover", borderRadius: 6 }} />}</td><td>{v.restaurant}</td><td>{v.caption_ar}{v.rejection_reason && <div className="xs error-text">{v.rejection_reason}</div>}</td><td className="num">{v.view_count}</td><td className="num">{v.orders}</td><td><StatusBadge s={v.status} /><div className="xs muted">{date(v.created_at)}</div></td></tr>)}</tbody></table>
              )}
            </section>
          </>
        )}
      </Loadable>
    </>
  );
}

function Upload() {
  const rs = useQuery("/restaurants");
  const [slug, setSlug] = useState("");
  const [menu, setMenu] = useState<any>(null);
  const [items, setItems] = useState<string[]>([]);
  const [caption, setCaption] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (s: string) => {
    setSlug(s);
    setItems([]);
    setMenu(s ? await get(`/restaurants/${s}`) : null);
  };
  const submit = async () => {
    if (!file || !menu) return;
    setBusy(true);
    try {
      const up = await fetch("/api/v1/media/upload", { method: "POST", headers: { "content-type": file.type, authorization: `Bearer ${session.token}` }, body: file });
      const upj = await up.json();
      if (!up.ok) throw new Error(upj.error?.message ?? "upload failed");
      await post("/creator/videos", { restaurantId: menu.restaurant.id, videoUrl: upj.url, captionAr: caption, itemIds: items });
      toast("تم الرفع — بانتظار المراجعة");
      location.hash = "/overview";
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHead title="رفع فيديو" sub="فيديو عمودي MP4 حتى ٦٠ ميجا. كل فيديو يجب أن يرتبط بطبق واحد على الأقل، ويمر بالمراجعة قبل النشر." />
      <section className="panel stack lg" style={{ maxWidth: 640 }}>
        <div className="field"><label htmlFor="f">الملف</label><input id="f" type="file" accept="video/mp4" className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
        <div className="field"><label htmlFor="r">المطعم</label>
          <Loadable q={rs}>{(d) => <select id="r" className="input" value={slug} onChange={(e) => void pick(e.target.value)}><option value="">اختر المطعم</option>{d.restaurants.map((r: any) => <option key={r.id} value={r.slug}>{r.name_ar}</option>)}</select>}</Loadable>
        </div>
        {menu && (
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend className="small" style={{ fontWeight: 600, marginBottom: 6 }}>الأطباق الظاهرة في الفيديو</legend>
            <div className="chips" style={{ flexWrap: "wrap" }}>
              {menu.menu.flatMap((c: any) => c.items).map((it: any) => (
                <button key={it.id} type="button" className="chip" aria-pressed={items.includes(it.id)} onClick={() => setItems((x) => (x.includes(it.id) ? x.filter((y) => y !== it.id) : [...x, it.id]))}>{it.name_ar}</button>
              ))}
            </div>
          </fieldset>
        )}
        <div className="field"><label htmlFor="c">الوصف</label><textarea id="c" className="input" rows={3} maxLength={300} value={caption} onChange={(e) => setCaption(e.target.value)} /></div>
        <button className="btn primary lg" disabled={busy || !file || !items.length || !caption} onClick={() => void submit()}>{busy ? "جارٍ الرفع…" : "رفع للمراجعة"}</button>
      </section>
    </>
  );
}

function Campaigns() {
  const q = useQuery("/creator/me");
  return (
    <>
      <PageHead title="الحملات" sub="الاشتراك في الحملات اختياري. الحوافز لا تُطبق إلا بعد موافقة أبو9 على اشتراكك." />
      <Loadable q={q}>{(d) => d.campaigns.length === 0 ? <Empty title="لا حملات فعّالة حالياً" body="سنعلمك عند إطلاق حملات جديدة." /> : (
        <div className="panel table-wrap"><table className="table"><thead><tr><th>الحملة</th><th>المطعم</th><th>الحافز</th><th>اشتراكك</th><th /></tr></thead>
          <tbody>{d.campaigns.map((c: any) => <tr key={c.id}><td>{c.name}</td><td>{c.restaurant ?? "كل المطاعم"}</td><td className="num">{c.incentive_type === "fixed_per_order" ? `${sar(c.incentive_value)} / طلب` : c.incentive_type === "percent_of_food" ? `${c.incentive_value / 100}٪` : "—"}</td><td>{c.enrollment ? <StatusBadge s={c.enrollment === "opted_in" ? "pending" : c.enrollment} /> : "—"}</td>
            <td>{!c.enrollment && <button className="btn sm primary" onClick={async () => { await post(`/creator/campaigns/${c.id}/opt-in`).then(() => { toast("تم الاشتراك — بانتظار الموافقة"); void q.reload(); }).catch((e) => toast(e.message, true)); }}>اشترك</button>}</td></tr>)}</tbody></table></div>)}</Loadable>
    </>
  );
}

mount(App);
