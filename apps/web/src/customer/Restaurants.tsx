import { useState } from "react";
import { put, del } from "../shared/api.ts";
import { L, sar, t } from "../shared/i18n.ts";
import { Empty, Icon, Loadable, toast, useQuery, useSession } from "../shared/ui.tsx";
import { GroupBanner, startGroup } from "./Extras.tsx";
import { useGroup } from "./cart.ts";
import { ItemSheet, type MenuItem } from "./ItemSheet.tsx";
import { useLocation } from "./location.ts";

const TAGS: Array<[string | null, string]> = [[null, "الكل"], ["burger", "برجر"], ["saudi", "سعودي"], ["grills", "مشاوي"], ["shawarma", "شاورما"], ["breakfast", "فطور"], ["dessert", "حلا وقهوة"]];

function Logo({ name, color, cover }: { name: string; color: string; cover?: string | null }) {
  return (
    <div className="logo" style={{ background: cover ? `linear-gradient(rgba(28,22,51,.25),rgba(28,22,51,.45)), url(${cover}) center/cover` : color }} aria-hidden="true">
      {name.slice(0, 1)}
    </div>
  );
}

export function Restaurants({ go }: { go: (r: string) => void }) {
  const loc = useLocation();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const params = new URLSearchParams({ lat: String(loc.lat), lng: String(loc.lng), ...(q ? { q } : {}), ...(tag ? { tag } : {}) });
  const res = useQuery(`/restaurants?${params}`);
  return (
    <>
      <div className="topbar"><h1>{t("المطاعم")}</h1></div>
      <div className="screen stack">
        <label className="row input" style={{ gap: 8 }}>
          <Icon.search size={20} />
          <input className="grow" style={{ border: 0, outline: 0, background: "none" }} placeholder={t("ابحث عن مطعم أو طبق")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("ابحث عن مطعم أو طبق")} />
        </label>
        <div className="chips" role="group" aria-label="التصنيف">
          {TAGS.map(([k, label]) => (
            <button key={label} className="chip" aria-pressed={tag === k} onClick={() => setTag(k)}>{label}</button>
          ))}
        </div>
        <Loadable q={res}>
          {(d) =>
            d.restaurants.length === 0 ? (
              <Empty title="لا نتائج" body="جرّب كلمة أخرى أو تصنيفاً مختلفاً." />
            ) : (
              <div>
                {d.restaurants.map((r: any) => (
                  <button key={r.id} className="rest" onClick={() => go(`r/${r.slug}`)}>
                    <Logo name={r.name_ar} color={r.brand_color} cover={r.cover} />
                    <div className="grow stack" style={{ gap: 2 }}>
                      <div className="row between"><h3 style={{ fontSize: 17 }}>{L(r)}</h3>{r.is_demo && <span className="demo-flag">تجريبي</span>}</div>
                      <p className="small muted">{r.description_ar}</p>
                      <div className="row xs muted" style={{ gap: 10 }}>
                        {r.rating && <span>★ <span className="num">{r.rating}</span> (<span className="num">{r.rating_count}</span>)</span>}
                        {r.servesYourArea === true && <span className="badge ok">{t("يوصّل لك")}</span>}
                        {r.servesYourArea === false && <span className="badge">{t("خارج منطقتك")}</span>}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )
          }
        </Loadable>
      </div>
    </>
  );
}

export function RestaurantPage({ slug, go }: { slug: string; go: (r: string) => void }) {
  const authed = !!useSession();
  const res = useQuery(`/restaurants/${slug}`);
  const [sheet, setSheet] = useState<MenuItem | null>(null);
  const group = useGroup();
  const toggleFav = async (id: string, fav: boolean) => {
    if (!authed) return go("account");
    await (fav ? del(`/me/favorites/${id}`) : put(`/me/favorites/${id}`));
    res.setData((d: any) => ({ ...d, favorite: !fav }));
  };
  return (
    <Loadable q={res} skeleton={<div className="screen" style={{ paddingTop: 16 }}><div className="skeleton" style={{ height: 160 }} /></div>}>
      {(d) => (
        <>
          <div className="topbar" style={{ background: "var(--c-ink)", color: "#fff" }}>
            <button className="btn ghost sm" style={{ color: "#fff" }} onClick={() => history.back()} aria-label="رجوع"><Icon.back /></button>
            <h1 className="grow">{L(d.restaurant)}</h1>
            <button className="btn ghost sm" style={{ color: d.favorite ? "var(--c-sadu)" : "#fff" }} aria-pressed={d.favorite} aria-label="مفضلة" onClick={() => void toggleFav(d.restaurant.id, d.favorite)}><Icon.heart /></button>
          </div>
          <div className="screen">
            <div className="hero-band stack" style={{ gap: 6 }}>
              <p style={{ opacity: 0.85 }}>{d.restaurant.description_ar}</p>
              <div className="row small" style={{ gap: 12, opacity: 0.9 }}>
                {d.restaurant.rating && <span>★ <span className="num">{d.restaurant.rating}</span></span>}
                <span>{d.branches.length} {d.branches.length > 1 ? "فروع" : "فرع"}</span>
                <span>تحضير ~<span className="num">{d.branches[0]?.prep_minutes_default}</span> د</span>
                {d.restaurant.is_demo && <span className="demo-flag" style={{ color: "#ccc", borderColor: "#888" }}>بيانات تجريبية</span>}
              </div>
            </div>
            <GroupBanner go={go} />
            {authed && !group && d.branches[0] && (
              <button className="btn sm" style={{ marginTop: 12 }} onClick={() => void startGroup(d.restaurant, (d.branches.find((b: any) => b.accepting_orders) ?? d.branches[0]).id, go)}>{t("طلب جماعي مع الأصدقاء")}</button>
            )}
            {d.videos.length > 0 && (
              <div className="row" style={{ overflowX: "auto", gap: 8, padding: "14px 0" }}>
                {d.videos.map((v: any) => (
                  <button key={v.id} onClick={() => go("feed")} style={{ border: 0, padding: 0, background: "none", cursor: "pointer", flex: "none" }} aria-label={v.caption_ar}>
                    <img src={v.poster_url} alt="" style={{ width: 96, height: 150, objectFit: "cover", borderRadius: 14 }} />
                  </button>
                ))}
              </div>
            )}
            {d.menu.map((c: any) => (
              <section key={c.id} style={{ marginTop: 14 }}>
                <h3>{L(c)}</h3>
                {c.items.map((it: any) => (
                  <button key={it.id} className={`item ${it.is_available ? "" : "off"}`} disabled={!it.is_available} onClick={() => setSheet(it)}>
                    <div className="grow stack" style={{ gap: 2 }}>
                      <h4>{L(it)}</h4>
                      {it.description_ar && <p className="small muted">{it.description_ar}</p>}
                      <span className="num" style={{ fontWeight: 700 }}>{sar(it.price)}</span>
                      {!it.is_available && <span className="badge">غير متوفر الآن</span>}
                    </div>
                    <div className="thumb" style={{ background: d.restaurant.brand_color }} aria-hidden="true">{it.name_ar.slice(0, 1)}</div>
                  </button>
                ))}
              </section>
            ))}
          </div>
          {sheet && (
            <ItemSheet
              item={sheet}
              restaurant={d.restaurant}
              onClose={() => setSheet(null)}
              onAdded={(ok, group, error) => {
                setSheet(null);
                if (group) toast(ok ? t("أُضيف للطلب الجماعي") : error ?? "تعذّرت الإضافة", !ok);
                else toast(ok ? t("تمت الإضافة") : "سلتك فيها طلب من مطعم آخر. الطلب من مطعم واحد فقط.", !ok);
              }}
            />
          )}
        </>
      )}
    </Loadable>
  );
}
