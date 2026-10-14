import { useState } from "react";
import { post } from "../shared/api.ts";
import { date, sar } from "../shared/i18n.ts";
import { confirmDialog, Loadable, StatusBadge, toast, useQuery } from "../shared/ui.tsx";

export const incentiveLabel = (c: any) =>
  c.incentive_type === "fixed_per_order" ? `${sar(c.incentive_value)} لكل طلب` : c.incentive_type === "percent_of_food" ? `${c.incentive_value / 100}٪ من قيمة الأكل` : "بدون حافز مالي";

/** Restaurant-funded creator campaigns: proposed here, approved by ABU9, creators opt in. */
export function CreatorCampaigns({ rid }: { rid: string }) {
  const q = useQuery(`/restaurant/${rid}/creator-campaigns`);
  const [f, setF] = useState({ name: "", type: "fixed_per_order", value: "5", budget: "500", days: "30" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const create = async () => {
    try {
      await post(`/restaurant/${rid}/creator-campaigns`, {
        name: f.name,
        incentiveType: f.type,
        incentiveValue: f.type === "percent_of_food" ? Math.round(Number(f.value) * 100) : f.type === "fixed_per_order" ? Math.round(Number(f.value) * 100) : 0,
        budget: f.type === "none" ? 0 : Math.round(Number(f.budget) * 100),
        endsAt: new Date(Date.now() + Number(f.days) * 86_400_000).toISOString(),
      });
      toast("أُرسلت الحملة لموافقة أبو9");
      setF({ ...f, name: "" });
      await q.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const stop = async (c: any, status: "paused" | "ended") => {
    if (!(await confirmDialog(status === "ended" ? `إنهاء «${c.name}» نهائياً؟` : `إيقاف «${c.name}» مؤقتاً؟`, { label: "إعادة التشغيل بعد الإيقاف تتم عبر فريق أبو9.", danger: status === "ended" }))) return;
    try { await post(`/restaurant/${rid}/creator-campaigns/${c.id}/status`, { status }); await q.reload(); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="cols" style={{ marginTop: 24 }}>
      <section className="panel stack">
        <h3>حملة مع صنّاع المحتوى</h3>
        <p className="xs muted">الحوافز اختيارية: يدفع المطعم للصانع عن كل طلب منسوب إليه وتم توصيله، ضمن ميزانية لا تُتجاوز. تحتاج الحملة واشتراك كل صانع موافقة أبو9.</p>
        <div className="field"><label htmlFor="cc-n">اسم الحملة</label><input id="cc-n" className="input" value={f.name} onChange={set("name")} placeholder="مثال: برجر الشتاء" /></div>
        <div className="row">
          <div className="field grow"><label htmlFor="cc-t">الحافز</label><select id="cc-t" className="input" value={f.type} onChange={set("type")}><option value="fixed_per_order">مبلغ لكل طلب</option><option value="percent_of_food">نسبة من قيمة الأكل</option><option value="none">بدون حافز (محتوى فقط)</option></select></div>
          {f.type !== "none" && <div className="field grow"><label htmlFor="cc-v">{f.type === "percent_of_food" ? "النسبة ٪" : "المبلغ (ر.س)"}</label><input id="cc-v" className="input num" inputMode="decimal" value={f.value} onChange={set("value")} /></div>}
        </div>
        <div className="row">
          {f.type !== "none" && <div className="field grow"><label htmlFor="cc-b">الميزانية (ر.س)</label><input id="cc-b" className="input num" inputMode="decimal" value={f.budget} onChange={set("budget")} /></div>}
          <div className="field grow"><label htmlFor="cc-d">المدة (أيام)</label><input id="cc-d" className="input num" inputMode="numeric" value={f.days} onChange={set("days")} /></div>
        </div>
        <button className="btn primary" disabled={f.name.trim().length < 3} onClick={() => void create()}>إرسال للموافقة</button>
      </section>
      <Loadable q={q}>
        {(d) => (
          <section className="panel table-wrap">
            <h3>حملاتك</h3>
            {d.campaigns.length === 0 ? <p className="muted small">لا حملات بعد.</p> : (
              <table className="table">
                <thead><tr><th>الحملة</th><th>الحافز</th><th>الصرف</th><th>الصنّاع</th><th>الحالة</th><th /></tr></thead>
                <tbody>{d.campaigns.map((c: any) => (
                  <tr key={c.id}>
                    <td>{c.name}{c.ends_at && <div className="xs muted">حتى {date(c.ends_at)}</div>}</td>
                    <td className="small">{incentiveLabel(c)}</td>
                    <td className="num small">{sar(c.spent)} / {sar(c.budget)}</td>
                    <td className="num small">{c.creators_approved}{c.creators_pending > 0 && <span className="muted"> (+{c.creators_pending})</span>}</td>
                    <td><StatusBadge s={c.status} /></td>
                    <td className="row" style={{ gap: 4 }}>
                      {c.status === "active" && <button className="btn sm ghost" onClick={() => void stop(c, "paused")}>إيقاف</button>}
                      {c.status !== "ended" && <button className="btn sm ghost" onClick={() => void stop(c, "ended")}>إنهاء</button>}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>
        )}
      </Loadable>
    </div>
  );
}
