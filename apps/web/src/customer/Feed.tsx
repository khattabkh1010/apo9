import { useEffect, useRef, useState } from "react";
import { get, post } from "../shared/api.ts";
import { L, sar, t } from "../shared/i18n.ts";
import { Brand, ErrorBox, Icon, toast } from "../shared/ui.tsx";
import { cartStore } from "./cart.ts";
import { ItemSheet, type MenuItem } from "./ItemSheet.tsx";
import { useLocation } from "./location.ts";

interface FeedVideo {
  id: string;
  caption_ar: string;
  video_url: string;
  poster_url: string | null;
  like_count: number;
  view_count: number;
  liked: boolean;
  deliverable: boolean;
  restaurant: { id: string; slug: string; nameAr: string; nameEn: string; brandColor: string; rating: string | null };
  creator: { handle: string; displayName: string } | null;
  items: Array<{ id: string; nameAr: string; nameEn: string; price: number; available: boolean; hasRequiredOptions: boolean }>;
}

/**
 * The core experience: watch → discover → add. Videos autoplay muted when ≥60% visible;
 * every reel carries its linked dishes with one-tap add (or a customisation sheet when required).
 */
export function Feed({ go }: { go: (r: string) => void }) {
  const loc = useLocation();
  const [videos, setVideos] = useState<FeedVideo[] | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [muted, setMuted] = useState(true);
  const [sheet, setSheet] = useState<{ item: MenuItem; restaurant: any; videoId: string } | null>(null);
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const container = useRef<HTMLDivElement>(null);

  const load = () =>
    get(`/feed?lat=${loc.lat}&lng=${loc.lng}`)
      .then((r) => setVideos(r.videos))
      .catch(setErr);
  useEffect(() => {
    void load();
  }, [loc.lat, loc.lng]);

  useEffect(() => {
    if (!videos || !container.current) return;
    const seen = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const v = e.target.querySelector("video");
          const id = (e.target as HTMLElement).dataset.id!;
          if (e.intersectionRatio >= 0.6) {
            void v?.play().catch(() => null);
            if (!seen.has(id)) {
              seen.add(id);
              void post(`/videos/${id}/events`, { kind: "view" }).catch(() => null);
            }
          } else v?.pause();
        }
      },
      { root: container.current, threshold: [0, 0.6, 1] },
    );
    container.current.querySelectorAll(".reel").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [videos]);

  const like = (v: FeedVideo) => {
    const kind = v.liked ? "unlike" : "like";
    setVideos((vs) => vs!.map((x) => (x.id === v.id ? { ...x, liked: !x.liked, like_count: x.like_count + (x.liked ? -1 : 1) } : x)));
    void post(`/videos/${v.id}/events`, { kind }).catch(() => null);
  };

  const quickAdd = async (v: FeedVideo, it: FeedVideo["items"][number]) => {
    void post(`/videos/${v.id}/events`, { kind: "add_to_cart" }).catch(() => null);
    if (it.hasRequiredOptions) {
      const r = await get(`/restaurants/${v.restaurant.slug}`);
      const item = r.menu.flatMap((c: any) => c.items).find((x: any) => x.id === it.id);
      setSheet({ item, restaurant: r.restaurant, videoId: v.id });
      return;
    }
    const ok = cartStore.add({ id: v.restaurant.id, slug: v.restaurant.slug, nameAr: v.restaurant.nameAr }, { itemId: it.id, nameAr: it.nameAr, nameEn: it.nameEn, qty: 1, optionIds: [], optionsLabel: "", unitPrice: it.price }, v.id);
    onAdded(ok, it.id);
  };
  const onAdded = (ok: boolean, itemId?: string) => {
    if (!ok) {
      toast("سلتك فيها طلب من مطعم آخر. الطلب من مطعم واحد فقط — أفرغ السلة أولاً.", true);
      return;
    }
    if (itemId) {
      setAdded((a) => ({ ...a, [itemId]: true }));
      setTimeout(() => setAdded((a) => ({ ...a, [itemId]: false })), 1600);
    }
    toast(t("تمت الإضافة"));
  };

  if (err) return <div style={{ padding: 16 }}><ErrorBox error={err} retry={load} /></div>;
  return (
    <div className="feed" ref={container}>
      {!videos && <div className="reel" style={{ display: "grid", placeItems: "center" }}><Brand /></div>}
      {videos?.length === 0 && (
        <div className="reel" style={{ display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
          <div className="stack"><h2>لا توجد فيديوهات في منطقتك بعد</h2><button className="btn primary" onClick={() => go("restaurants")}>تصفح المطاعم</button></div>
        </div>
      )}
      {videos?.map((v) => (
        <section className="reel" key={v.id} data-id={v.id} aria-label={`${v.restaurant.nameAr}: ${v.caption_ar}`}>
          {v.poster_url && <img className="poster" src={v.poster_url} alt="" />}
          <video src={v.video_url} poster={v.poster_url ?? undefined} muted={muted} loop playsInline preload="metadata" onClick={() => setMuted((m) => !m)} />
          <div className="shade" />
          <div className="head">
            <Brand />
            <button className="btn sm ghost" style={{ color: "#fff" }} onClick={() => setMuted((m) => !m)} aria-label={muted ? "تشغيل الصوت" : "كتم الصوت"}>
              {muted ? <Icon.mute /> : <Icon.sound />}
            </button>
          </div>
          <div className="side">
            <button className={v.liked ? "on" : ""} aria-pressed={v.liked} aria-label="إعجاب" onClick={() => like(v)}><Icon.heart /></button>
            <small className="num">{v.like_count}</small>
            <button aria-label="صفحة المطعم" onClick={() => { void post(`/videos/${v.id}/events`, { kind: "open_restaurant" }).catch(() => null); go(`r/${v.restaurant.slug}`); }}><Icon.store /></button>
            <button aria-label="مشاركة" onClick={() => { void navigator.share?.({ title: v.restaurant.nameAr, url: location.origin + `/customer#/r/${v.restaurant.slug}` }).catch(() => null); void post(`/videos/${v.id}/events`, { kind: "share" }).catch(() => null); }}><Icon.share /></button>
          </div>
          <div className="meta">
            <button className="who" style={{ background: "none", border: 0, color: "#fff", padding: 0, cursor: "pointer" }} onClick={() => go(`r/${v.restaurant.slug}`)}>
              {L(v.restaurant)}
            </button>
            <div className="row small" style={{ opacity: 0.85, gap: 8 }}>
              {v.restaurant.rating && <span>★ <span className="num">{v.restaurant.rating}</span></span>}
              {v.creator && <span>@{v.creator.handle}</span>}
              <span className={`badge ${v.deliverable ? "ok" : "warn"}`}>{v.deliverable ? t("يوصّل لك") : t("خارج منطقتك")}</span>
            </div>
            <p className="caption">{v.caption_ar}</p>
            <div className="dishes">
              {v.items.map((it) => (
                <div className="dish" key={it.id}>
                  <div className="grow">
                    <div className="name">{L(it)}</div>
                    <div className="price num">{sar(it.price)}{it.hasRequiredOptions && <span className="xs muted" style={{ fontFamily: "var(--f-body)", fontWeight: 400 }}> · {t("اختر الإضافات")}</span>}</div>
                  </div>
                  <button className={`add ${added[it.id] ? "done" : ""}`} disabled={!it.available} aria-label={`${t("أضف للسلة")}: ${L(it)}`} onClick={() => void quickAdd(v, it)}>
                    {added[it.id] ? <Icon.check /> : "+"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      ))}
      {sheet && (
        <ItemSheet item={sheet.item} restaurant={sheet.restaurant} videoId={sheet.videoId} onClose={() => setSheet(null)} onAdded={(ok) => { setSheet(null); onAdded(ok); }} />
      )}
    </div>
  );
}
