import { useEffect, useState } from "react";
import { del, post } from "../shared/api.ts";
import { date, L, sar, t, time } from "../shared/i18n.ts";
import { Empty, Icon, Loadable, Sheet, confirmDialog, toast, useQuery } from "../shared/ui.tsx";
import { cartStore, groupStore, useGroup } from "./cart.ts";
import { locationStore } from "./location.ts";

// Approximate neighbourhood centres for the launch zones. Used only when the device location is
// unavailable; a map picker needs a maps provider (LAUNCH_BLOCKERS §D).
const DISTRICTS: Array<[string, number, number]> = [
  ["العليا", 24.6935, 46.6855],
  ["الملقا", 24.8095, 46.6185],
  ["حطين", 24.7652, 46.6021],
  ["الياسمين", 24.8247, 46.6417],
];

// ───────────────────────── addresses ─────────────────────────
export function AddressSheet({ onClose, onSaved }: { onClose: () => void; onSaved: (a: any) => void }) {
  const [label, setLabel] = useState("البيت");
  const [district, setDistrict] = useState(DISTRICTS[0]![0]);
  const [point, setPoint] = useState<{ lat: number; lng: number; precise: boolean }>({ lat: DISTRICTS[0]![1], lng: DISTRICTS[0]![2], precise: false });
  const [details, setDetails] = useState("");
  const [building, setBuilding] = useState("");
  const [notes, setNotes] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const locate = () => {
    if (!navigator.geolocation) return toast("الموقع غير متاح في هذا المتصفح", true);
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setPoint({ lat: p.coords.latitude, lng: p.coords.longitude, precise: true }); setBusy(false); toast("تم تحديد موقعك"); },
      () => { setBusy(false); toast("تعذّر تحديد الموقع — اختر الحي يدوياً", true); },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await post("/me/addresses", { label, lat: point.lat, lng: point.lng, district, details: details || undefined, building: building || undefined, notes: notes || undefined, isDefault });
      toast(t("حُفظ العنوان"));
      onSaved(r.address);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet label={t("عنوان جديد")} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h2>{t("عنوان جديد")}</h2>
        <div className="chips">
          {["البيت", "العمل", "أخرى"].map((x) => <button type="button" key={x} className="chip" aria-pressed={label === x} onClick={() => setLabel(x)}>{x}</button>)}
        </div>
        <button type="button" className="btn" disabled={busy} onClick={locate}><Icon.pin size={18} /> {t("استخدم موقعي الحالي")}</button>
        <div className="field">
          <label htmlFor="ad-d">{t("الحي")}</label>
          <select id="ad-d" className="input" value={district} onChange={(e) => {
            const d = DISTRICTS.find((x) => x[0] === e.target.value)!;
            setDistrict(d[0]);
            if (!point.precise) setPoint({ lat: d[1], lng: d[2], precise: false });
          }}>
            {DISTRICTS.map(([n]) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span className="hint">{point.precise ? "موقع دقيق من جهازك ✓" : "موقع تقريبي لوسط الحي — استخدم موقعك الحالي لدقة أعلى."}</span>
        </div>
        <div className="field"><label htmlFor="ad-s">{t("الشارع والتفاصيل")}</label><input id="ad-s" className="input" value={details} onChange={(e) => setDetails(e.target.value)} /></div>
        <div className="field"><label htmlFor="ad-b">{t("المبنى / الشقة")}</label><input id="ad-b" className="input" value={building} onChange={(e) => setBuilding(e.target.value)} /></div>
        <div className="field"><label htmlFor="ad-n">{t("ملاحظات للمندوب")}</label><input id="ad-n" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="مثال: البوابة الجانبية" /></div>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> {t("العنوان الافتراضي")}</label>
        <button className="btn primary lg block" disabled={busy}>{t("حفظ العنوان")}</button>
      </form>
    </Sheet>
  );
}

export function AddressList() {
  const q = useQuery("/me/addresses");
  const [adding, setAdding] = useState(false);
  const remove = async (a: any) => {
    if (!(await confirmDialog(`حذف عنوان «${a.label}»؟`, { danger: true, confirmLabel: "حذف" }))) return;
    try {
      await del(`/me/addresses/${a.id}`);
      if (locationStore.get().addressId === a.id) locationStore.set({ lat: 24.693, lng: 46.688, label: "العليا (موقع تجريبي)", addressId: null });
      await q.reload();
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <section className="panel tight stack">
      <div className="row between"><h3>{t("عناويني")}</h3><button className="btn sm ghost" onClick={() => setAdding(true)}>+ {t("إضافة")}</button></div>
      <Loadable q={q}>
        {(d) => d.addresses.length === 0 ? <p className="small muted">{t("لا توجد عناوين محفوظة.")}</p> : d.addresses.map((a: any) => (
          <div key={a.id} className="row small">
            <Icon.pin size={18} />
            <span className="grow">{a.label} · {a.district} <span className="muted">{a.details}</span></span>
            {a.is_default && <span className="badge">{t("افتراضي")}</span>}
            <button className="btn sm ghost" aria-label={`حذف ${a.label}`} onClick={() => void remove(a)}>✕</button>
          </div>
        ))}
      </Loadable>
      {adding && <AddressSheet onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void q.reload(); }} />}
    </section>
  );
}

// ───────────────────────── favourites ─────────────────────────
export function Favorites({ go }: { go: (r: string) => void }) {
  const q = useQuery("/me/favorites");
  return (
    <>
      <div className="topbar"><button className="btn ghost sm" onClick={() => go("account")} aria-label="رجوع"><Icon.back /></button><h1>{t("المفضلة")}</h1></div>
      <div className="screen stack">
        <Loadable q={q}>
          {(d) => d.favorites.length === 0 ? <Empty title={t("لا توجد مطاعم مفضلة بعد")} body={t("اضغط على القلب في صفحة أي مطعم لحفظه هنا.")} action={<button className="btn primary" onClick={() => go("restaurants")}>{t("المطاعم")}</button>} /> : d.favorites.map((r: any) => (
            <button key={r.id} className="item" onClick={() => go(`r/${r.slug}`)}>
              <div className="thumb" style={{ background: r.brand_color ?? "var(--c-ink)" }} aria-hidden="true">{r.name_ar.slice(0, 1)}</div>
              <h4 className="grow">{L(r)}</h4>
            </button>
          ))}
        </Loadable>
      </div>
    </>
  );
}

// ───────────────────────── notifications ─────────────────────────
export function Notifications({ go }: { go: (r: string) => void }) {
  const q = useQuery("/me/notifications");
  // Opening the screen marks everything read (the list keeps showing what was new on arrival).
  useEffect(() => {
    void post("/me/notifications/read").catch(() => null);
  }, []);
  return (
    <>
      <div className="topbar"><button className="btn ghost sm" onClick={() => go("account")} aria-label="رجوع"><Icon.back /></button><h1>{t("الإشعارات")}</h1></div>
      <div className="screen stack">
        <Loadable q={q}>
          {(d) => d.notifications.length === 0 ? <Empty title={t("لا توجد إشعارات")} /> : d.notifications.map((n: any) => (
            <button key={n.id} className="panel tight stack" style={{ textAlign: "start", border: n.read_at ? undefined : "1px solid var(--c-saffron)", cursor: n.data?.orderId ? "pointer" : "default" }} onClick={() => n.data?.orderId && go(`o/${n.data.orderId}`)}>
              <div className="row between"><strong>{L(n, "title")}</strong>{!n.read_at && <span className="badge warn">{t("جديد")}</span>}</div>
              {n.body_ar && <span className="small muted">{L(n, "body")}</span>}
              <span className="xs muted num">{date(n.created_at)} {time(n.created_at)}</span>
            </button>
          ))}
        </Loadable>
      </div>
    </>
  );
}

// ───────────────────────── group ordering ─────────────────────────
/** Host starts a shared cart at one branch; friends with the link add their own items; host pays. */
export async function startGroup(restaurant: { id: string }, branchId: string, go: (r: string) => void) {
  try {
    const r = await post("/group-carts", { branchId });
    groupStore.set({ code: r.groupCart.code, restaurantId: restaurant.id });
    go(`g/${r.groupCart.code}`);
  } catch (e) {
    toast((e as Error).message, true);
  }
}

export function GroupPage({ code, go }: { code: string; go: (r: string) => void }) {
  const q = useQuery(`/group-carts/${code}`, { poll: 5_000 });
  const active = useGroup();
  const [busy, setBusy] = useState(false);
  const link = `${location.origin}/customer#/g/${code}`;
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: "طلب جماعي على أبو9", text: "أضف طلبك معنا", url: link });
      else { await navigator.clipboard.writeText(link); toast(t("نُسخ الرابط")); }
    } catch { /* user cancelled share */ }
  };
  return (
    <>
      <div className="topbar"><button className="btn ghost sm" onClick={() => go("feed")} aria-label="رجوع"><Icon.back /></button><h1>{t("طلب جماعي")}</h1></div>
      <div className="screen stack lg">
        <Loadable q={q}>
          {(d) => {
            const g = d.groupCart;
            const open = g.status === "open" && new Date(g.expires_at) > new Date();
            const joined = active?.code === code;
            const byPerson = new Map<string, any[]>();
            for (const it of d.items) byPerson.set(it.user_name ?? "ضيف", [...(byPerson.get(it.user_name ?? "ضيف") ?? []), it]);
            const total = d.items.reduce((a: number, i: any) => a + i.qty * (i.price + i.options.reduce((x: number, o: any) => x + o.priceDelta, 0)), 0);
            return (
              <>
                <section className="panel tight stack">
                  <div className="row between"><h3>{g.restaurant_name_ar}</h3><span className="badge">{open ? t("مفتوح") : g.status === "ordered" ? t("تم الطلب") : t("مقفل")}</span></div>
                  <p className="small muted">{t("الرمز")} <span className="num">{g.code}</span> · {t("ينتهي")} <span className="num">{time(g.expires_at)}</span> · {d.isHost ? t("أنت المضيف وتدفع الطلب كاملاً") : t("المضيف يدفع الطلب")}</p>
                  {open && (
                    <div className="row" style={{ gap: 8 }}>
                      <button className="btn sm" onClick={() => void share()}>{t("مشاركة الرابط")}</button>
                      <button className="btn sm primary" onClick={() => { groupStore.set({ code, restaurantId: g.restaurant_id }); go(`r/${g.slug}`); }}>{joined ? t("أضف المزيد من المنيو") : t("انضم وأضف طلبك")}</button>
                    </div>
                  )}
                </section>
                <section className="panel tight stack">
                  {d.items.length === 0 ? <p className="muted small">{t("لم يُضف أحد شيئاً بعد.")}</p> : [...byPerson.entries()].map(([who, items]) => (
                    <div key={who} className="stack" style={{ gap: 4 }}>
                      <strong className="small">{who}</strong>
                      {items.map((i: any) => (
                        <div key={i.id} className="row between small">
                          <span>{i.name_ar} <span className="num muted">×{i.qty}</span>{i.options.length > 0 && <span className="xs muted"> · {i.options.map((o: any) => o.nameAr).join("، ")}</span>}</span>
                          {open && (d.isHost || i.user_id === d.me) && <button className="btn sm ghost" aria-label="حذف" onClick={async () => { try { await del(`/group-carts/${code}/items/${i.id}`); await q.reload(); } catch (e) { toast((e as Error).message, true); } }}>✕</button>}
                        </div>
                      ))}
                    </div>
                  ))}
                  {d.items.length > 0 && <div className="row between"><span>{t("تقدير قيمة الأكل")}</span><span className="num">{sar(total)}</span></div>}
                  <p className="xs muted">{t("السعر النهائي والتوصيل يُحسبان عند الدفع.")}</p>
                </section>
                {d.isHost && g.status !== "ordered" && d.items.length > 0 && (
                  <button className="btn primary lg block" disabled={busy} onClick={async () => {
                    if (open && !(await confirmDialog(t("إقفال الطلب الجماعي والانتقال للدفع؟"), { label: t("لن يتمكن أحد من الإضافة بعد الإقفال.") }))) return;
                    setBusy(true);
                    try {
                      if (open) await post(`/group-carts/${code}/lock`);
                      const fresh = await (await fetch(`/api/v1/group-carts/${code}`, { credentials: "same-origin" })).json();
                      cartStore.loadGroup(fresh.groupCart, fresh.items);
                      groupStore.set(null);
                      go("cart");
                    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
                  }}>{t("إقفال والدفع")}</button>
                )}
                {joined && !d.isHost && <button className="btn ghost" onClick={() => { groupStore.set(null); go("feed"); }}>{t("الخروج من الطلب الجماعي")}</button>}
              </>
            );
          }}
        </Loadable>
      </div>
    </>
  );
}

/** Banner shown while adding items to a group order. */
export function GroupBanner({ go }: { go: (r: string) => void }) {
  const g = useGroup();
  if (!g) return null;
  return (
    <button className="notice small" style={{ width: "100%", border: 0, cursor: "pointer", textAlign: "start" }} onClick={() => go(`g/${g.code}`)}>
      {t("تضيف إلى طلب جماعي")} <span className="num">#{g.code}</span> — {t("عرض السلة المشتركة")}
    </button>
  );
}
