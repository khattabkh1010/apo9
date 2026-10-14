import { useState } from "react";
import { del, patch, post, put } from "../shared/api.ts";
import { date, sar } from "../shared/i18n.ts";
import { ask, confirmDialog, Loadable, PageHead, Sheet, toast, useQuery } from "../shared/ui.tsx";

const toHalalas = (s: string) => Math.round(Number(s) * 100);
const errMsg = (e: unknown) => toast((e as Error).message || "حدث خطأ", true);

// ───────────────────────── application (no restaurant yet) ─────────────────────────
export function Apply({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ nameAr: "", nameEn: "", cuisine: "", crNumber: "", vatNumber: "", branchAr: "", branchEn: "", district: "", lat: "24.6962", lng: "46.6849" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setBusy(true);
    try {
      await post("/restaurant-applications", {
        nameAr: f.nameAr, nameEn: f.nameEn, cuisineTags: f.cuisine.split(/[,،]/).map((x) => x.trim()).filter(Boolean),
        crNumber: f.crNumber, ...(f.vatNumber ? { vatNumber: f.vatNumber } : {}),
        branch: { nameAr: f.branchAr, nameEn: f.branchEn || f.branchAr, district: f.district || undefined, lat: Number(f.lat), lng: Number(f.lng) },
      });
      toast("تم إنشاء طلب الانضمام");
      onDone();
    } catch (e) {
      errMsg(e);
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof typeof f, label: string, opts: { hint?: string; num?: boolean; dir?: "ltr" } = {}) => (
    <div className="field">
      <label htmlFor={`ap-${k}`}>{label}</label>
      <input id={`ap-${k}`} className={`input ${opts.num ? "num" : ""}`} dir={opts.dir} inputMode={opts.num ? "numeric" : undefined} value={f[k]} onChange={set(k)} />
      {opts.hint && <span className="hint">{opts.hint}</span>}
    </div>
  );
  return (
    <div className="main" style={{ maxWidth: 720, margin: "0 auto" }}>
      <PageHead title="انضم إلى أبو9" sub="التسجيل وإعداد المنيو والتدريب الأساسي مجاناً. تبدأ الفترة التجريبية (30 يوماً) من تاريخ التفعيل، ولا عمولة على قيمة الطلبات في باقات الاشتراك." />
      <form className="panel stack lg" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h3>بيانات المطعم</h3>
        <div className="grid-2">
          {field("nameAr", "الاسم بالعربية")}
          {field("nameEn", "الاسم بالإنجليزية", { dir: "ltr" })}
        </div>
        {field("cuisine", "نوع المطبخ", { hint: "افصل بفواصل: برجر، سعودي، حلويات" })}
        <div className="grid-2">
          {field("crNumber", "رقم السجل التجاري", { num: true, hint: "10 أرقام" })}
          {field("vatNumber", "الرقم الضريبي (اختياري)", { num: true, hint: "15 رقماً يبدأ وينتهي بـ 3" })}
        </div>
        <h3>الفرع الأول</h3>
        <div className="grid-2">
          {field("branchAr", "اسم الفرع")}
          {field("district", "الحي")}
        </div>
        <div className="grid-2">
          {field("lat", "خط العرض", { num: true, dir: "ltr" })}
          {field("lng", "خط الطول", { num: true, dir: "ltr" })}
        </div>
        <p className="xs muted">اختيار الموقع على الخريطة غير متاح بعد؛ أدخل الإحداثيات من خرائط Google (ضغطة مطوّلة على موقع الفرع).</p>
        <button className="btn primary lg" disabled={busy || !f.nameAr || !f.nameEn || !f.cuisine || f.crNumber.length !== 10 || !f.branchAr}>إرسال طلب الانضمام</button>
      </form>
    </div>
  );
}

// ───────────────────────── onboarding checklist ─────────────────────────
const STEP_TEXT: Record<string, [string, string]> = {
  profile: ["بيانات المطعم", "الاسم، نوع المطبخ، السجل التجاري"],
  branch: ["فرع واحد على الأقل", "موقع الفرع"],
  hours: ["أوقات العمل", "لكل فرع، بتوقيت الرياض"],
  menu: ["المنيو", "قسم واحد و٣ أصناف مسعّرة على الأقل"],
  terms: ["اتفاقية الاشتراك", "الموافقة على شروط الاشتراك"],
  coverage: ["نطاق التوصيل", "يضبطه فريق عمليات أبو9 لكل فرع"],
};

export function Onboarding({ rid, go }: { rid: string; go: (r: string) => void }) {
  const q = useQuery(`/restaurant/${rid}/onboarding`);
  const accept = async (version: string) => {
    if (!(await confirmDialog("الموافقة على اتفاقية الاشتراك", { label: "مسودة الاتفاقية بانتظار المراجعة القانونية النهائية. لا خصومات تلقائية من مستحقاتك إلا بما توافق عليه صراحةً.", confirmLabel: "أوافق" }))) return;
    try { await post(`/restaurant/${rid}/terms/accept`, { version }); toast("تم تسجيل الموافقة"); await q.reload(); } catch (e) { errMsg(e); }
  };
  const target: Record<string, string> = { hours: "menu", menu: "menu", branch: "menu" };
  const fixProfile = async () => {
    const cr = await ask({ title: "رقم السجل التجاري", label: "10 أرقام كما في شهادة السجل.", minLength: 10 });
    if (!cr) return;
    try { await patch(`/restaurant/${rid}/profile`, { crNumber: cr.replace(/\D/g, "") }); toast("حُفظ"); await q.reload(); } catch (e) { errMsg(e); }
  };
  return (
    <>
      <PageHead title={q.data?.status === "onboarding" ? "تهيئة المطعم" : "بيانات المطعم"} sub={q.data?.status === "onboarding" ? "أكمل الخطوات ليقوم فريق أبو9 بالتفعيل. الفترة التجريبية المجانية تبدأ من يوم التفعيل." : "حالة بيانات المطعم والاتفاقية."} />
      <Loadable q={q}>
        {(d) => (
          <div className="stack lg">
            <section className="panel stack">
              {d.steps.map((s: any) => (
                <div key={s.key} className="row between" style={{ padding: "6px 0", borderBottom: "1px solid var(--c-line)" }}>
                  <div className="row" style={{ gap: 10 }}>
                    <span className={`badge ${s.done ? "ok" : s.owner === "ops" ? "warn" : ""}`} aria-hidden="true">{s.done ? "✓" : "•"}</span>
                    <div><strong>{STEP_TEXT[s.key]?.[0] ?? s.key}</strong><div className="xs muted">{STEP_TEXT[s.key]?.[1]}{s.owner === "ops" ? " · مسؤولية أبو9" : ""}</div></div>
                  </div>
                  {!s.done && s.key === "profile" && <button className="btn sm" onClick={() => void fixProfile()}>إكمال</button>}
                  {!s.done && s.key === "terms" && <button className="btn sm primary" onClick={() => void accept(d.termsVersion)}>مراجعة والموافقة</button>}
                  {!s.done && target[s.key] && <button className="btn sm" onClick={() => go(target[s.key]!)}>إكمال</button>}
                </div>
              ))}
            </section>
            <section className="panel stack">
              <h3>الحالة</h3>
              {d.status === "active" ? <p>المطعم مفعّل ويستقبل الطلبات.</p> : d.restaurantStepsDone ? <p>أكملت خطواتك. فريق العمليات يراجع الفروع ونطاق التوصيل ثم يفعّل المطعم.</p> : <p className="muted">أكمل الخطوات أعلاه.</p>}
              {d.terms?.signed_at && <p className="xs muted">وافقت على {d.termsVersion} بتاريخ {date(d.terms.signed_at)} · نافذة الاعتراض على المطالبات {d.terms.dispute_window_hours} ساعة.</p>}
            </section>
          </div>
        )}
      </Loadable>
    </>
  );
}

// ───────────────────────── menu building ─────────────────────────
export function MenuToolbar({ rid, categories, onChanged }: { rid: string; categories: any[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const addCategory = async () => {
    const nameAr = await ask({ title: "قسم جديد", label: "مثل: الأطباق الرئيسية، المشروبات", minLength: 2 });
    if (!nameAr) return;
    const nameEn = (await ask({ title: "اسم القسم بالإنجليزية", initial: nameAr, minLength: 2 })) ?? nameAr;
    try { await post(`/restaurant/${rid}/menu/categories`, { nameAr, nameEn }); onChanged(); } catch (e) { errMsg(e); }
  };
  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm" onClick={() => void addCategory()}>+ قسم</button>
        <button className="btn sm primary" disabled={!categories.length} title={categories.length ? undefined : "أضف قسماً أولاً"} onClick={() => setAdding(true)}>+ صنف</button>
      </div>
      {adding && <NewItem rid={rid} categories={categories} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); onChanged(); }} />}
    </>
  );
}

function NewItem({ rid, categories, onClose, onSaved }: { rid: string; categories: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ categoryId: categories[0]?.id ?? "", nameAr: "", nameEn: "", price: "", desc: "" });
  const ok = f.nameAr && f.nameEn && Number(f.price) > 0;
  return (
    <Sheet center label="صنف جديد" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { await post(`/restaurant/${rid}/menu/items`, { categoryId: f.categoryId, nameAr: f.nameAr, nameEn: f.nameEn, price: toHalalas(f.price), descriptionAr: f.desc || undefined }); toast("أُضيف الصنف"); onSaved(); } catch (er) { errMsg(er); }
      }}>
        <h2>صنف جديد</h2>
        <div className="field"><label htmlFor="ni-c">القسم</label><select id="ni-c" className="input" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name_ar}</option>)}</select></div>
        <div className="grid-2">
          <div className="field"><label htmlFor="ni-a">الاسم بالعربية</label><input id="ni-a" className="input" value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></div>
          <div className="field"><label htmlFor="ni-e">الاسم بالإنجليزية</label><input id="ni-e" className="input" dir="ltr" value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} /></div>
        </div>
        <div className="field"><label htmlFor="ni-p">السعر شامل الضريبة (ر.س)</label><input id="ni-p" className="input num" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></div>
        <div className="field"><label htmlFor="ni-d">الوصف</label><textarea id="ni-d" className="input" rows={2} value={f.desc} onChange={(e) => setF({ ...f, desc: e.target.value })} /></div>
        <button className="btn primary lg" disabled={!ok}>إضافة</button>
      </form>
    </Sheet>
  );
}

/** Variants (required single choice, e.g. size) and add-ons (optional multi choice). */
export function ModifiersSheet({ rid, item, onClose }: { rid: string; item: any; onClose: () => void }) {
  const q = useQuery(`/restaurant/${rid}/menu/items/${item.id}/modifier-groups`);
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); await q.reload(); } catch (e) { errMsg(e); } };
  const addGroup = async () => {
    const kind = await ask({ title: "نوع المجموعة", choices: [["variant", "خيار إلزامي واحد (مثل الحجم)"], ["addon", "إضافات اختيارية"]] });
    if (!kind) return;
    const nameAr = await ask({ title: "اسم المجموعة", initial: kind === "variant" ? "الحجم" : "إضافات", minLength: 2 });
    if (!nameAr) return;
    const max = kind === "addon" ? Number((await ask({ title: "أقصى عدد إضافات يختارها العميل", kind: "number", initial: "3", min: 1, max: 20 })) ?? 3) : 1;
    await run(() => post(`/restaurant/${rid}/menu/items/${item.id}/modifier-groups`, { nameAr, nameEn: nameAr, minSelect: kind === "variant" ? 1 : 0, maxSelect: max, options: kind === "variant" ? [{ nameAr: "عادي", nameEn: "Regular", priceDelta: 0 }] : undefined }));
  };
  const addOption = async (g: any) => {
    const nameAr = await ask({ title: `خيار جديد في «${g.name_ar}»`, minLength: 1 });
    if (!nameAr) return;
    const price = await ask({ title: "السعر الإضافي (ر.س)", label: "0 إذا لم يغيّر السعر", kind: "number", initial: "0", min: 0, max: 1000 });
    if (price === null) return;
    await run(() => post(`/restaurant/${rid}/modifier-groups/${g.id}/options`, { nameAr, nameEn: nameAr, priceDelta: toHalalas(price) }));
  };
  const editPrice = async (o: any) => {
    const price = await ask({ title: `سعر «${o.name_ar}» الإضافي (ر.س)`, kind: "number", initial: String(o.price_delta / 100), min: 0, max: 1000 });
    if (price !== null) await run(() => patch(`/restaurant/${rid}/modifier-options/${o.id}`, { priceDelta: toHalalas(price) }));
  };
  return (
    <Sheet center label={`خيارات ${item.name_ar}`} onClose={onClose}>
      <div className="stack">
        <div className="row between"><h2>خيارات {item.name_ar}</h2><button className="btn sm primary" onClick={() => void addGroup()}>+ مجموعة</button></div>
        <p className="xs muted">الأسعار الإضافية شاملة الضريبة. التغييرات تسجّل في سجل التدقيق، والطلبات السابقة تحتفظ بما اختاره العميل.</p>
        <Loadable q={q}>
          {(d) => d.groups.length === 0 ? <p className="muted">لا توجد خيارات بعد. أضف «الحجم» أو «إضافات».</p> : (
            <div className="stack">
              {d.groups.map((g: any) => (
                <section key={g.id} className="panel stack" style={{ padding: 12 }}>
                  <div className="row between">
                    <div><strong>{g.name_ar}</strong><div className="xs muted">{g.min_select > 0 ? `إلزامي · اختر ${g.min_select === g.max_select ? g.min_select : `${g.min_select}–${g.max_select}`}` : `اختياري · حتى ${g.max_select}`}</div></div>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn sm" onClick={() => void addOption(g)}>+ خيار</button>
                      <button className="btn sm ghost" onClick={async () => { if (await confirmDialog(`حذف مجموعة «${g.name_ar}»؟`, { danger: true, confirmLabel: "حذف" })) await run(() => del(`/restaurant/${rid}/modifier-groups/${g.id}`)); }}>حذف</button>
                    </div>
                  </div>
                  {g.options.map((o: any) => (
                    <div key={o.id} className="row between small">
                      <span>{o.name_ar} {o.price_delta > 0 && <span className="num muted">+{sar(o.price_delta)}</span>}</span>
                      <span className="row" style={{ gap: 6 }}>
                        <button className="btn sm ghost" onClick={() => void editPrice(o)}>السعر</button>
                        <button className="btn sm" onClick={() => void run(() => patch(`/restaurant/${rid}/modifier-options/${o.id}`, { isAvailable: !o.is_available }))}>{o.is_available ? "متوفر" : "نفد"}</button>
                        <button className="btn sm ghost" aria-label={`حذف ${o.name_ar}`} onClick={() => void run(() => del(`/restaurant/${rid}/modifier-options/${o.id}`))}>✕</button>
                      </span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}
        </Loadable>
      </div>
    </Sheet>
  );
}

// ───────────────────────── opening hours ─────────────────────────
const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

export function HoursSheet({ rid, branch, onClose, onSaved }: { rid: string; branch: any; onClose: () => void; onSaved: () => void }) {
  const init: Array<Array<[string, string]>> = DAYS.map((_, d) => (branch.opening_hours?.[String(d)] ?? []).map((r: [string, string]) => [r[0], r[1]]));
  const [h, setH] = useState(init);
  const setRange = (d: number, i: number, k: 0 | 1, v: string) => setH(h.map((day, dd) => (dd !== d ? day : day.map((r, ii) => (ii !== i ? r : (k === 0 ? [v, r[1]] : [r[0], v]) as [string, string])))));
  const save = async () => {
    try {
      await put(`/restaurant/${rid}/branches/${branch.id}/hours`, { hours: Object.fromEntries(h.map((r, d) => [String(d), r])) });
      toast("حُفظت أوقات العمل");
      onSaved();
    } catch (e) {
      errMsg(e);
    }
  };
  return (
    <Sheet center label="أوقات العمل" onClose={onClose}>
      <div className="stack">
        <h2>أوقات عمل {branch.name_ar}</h2>
        <p className="xs muted">بتوقيت الرياض. إذا كان الإغلاق بعد منتصف الليل اكتب وقت الإغلاق كما هو (مثل 16:00 – 02:00).</p>
        {DAYS.map((name, d) => (
          <div key={d} className="row between" style={{ gap: 8, alignItems: "flex-start" }}>
            <strong style={{ minWidth: 70 }}>{name}</strong>
            <div className="stack grow" style={{ gap: 4 }}>
              {h[d]!.length === 0 && <span className="small muted">مغلق</span>}
              {h[d]!.length === 1 && h[d]![0]![0] === "00:00" && h[d]![0]![1] === "24:00" && <span className="xs muted">مفتوح ٢٤ ساعة</span>}
              {h[d]!.map((r, i) => (
                <div key={i} className="row" style={{ gap: 6 }} dir="ltr">
                  <input type="time" className="input num" aria-label={`${name} فتح`} value={r[0]} onChange={(e) => setRange(d, i, 0, e.target.value)} />
                  <span>–</span>
                  <input type="time" className="input num" aria-label={`${name} إغلاق`} value={r[1] === "24:00" ? "00:00" : r[1]} onChange={(e) => setRange(d, i, 1, e.target.value === "00:00" ? "24:00" : e.target.value)} />
                  <button className="btn sm ghost" aria-label="حذف الفترة" onClick={() => setH(h.map((day, dd) => (dd === d ? day.filter((_, ii) => ii !== i) : day)))}>✕</button>
                </div>
              ))}
            </div>
            {h[d]!.length < 2 && <button className="btn sm" onClick={() => setH(h.map((day, dd) => (dd === d ? [...day, day.length ? ["19:00", "24:00"] : ["12:00", "24:00"]] : day)))}>+ فترة</button>}
          </div>
        ))}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary grow" onClick={() => void save()}>حفظ</button>
          <button className="btn ghost grow" onClick={() => setH(DAYS.map(() => h[0]!.map((r) => [...r] as [string, string])))}>نسخ أوقات الأحد لكل الأيام</button>
        </div>
      </div>
    </Sheet>
  );
}
