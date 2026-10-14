import { useEffect, useState } from "react";
import { ApiError, post, uuid } from "../shared/api.ts";
import { L, sar, t } from "../shared/i18n.ts";
import { Empty, Icon, Skeleton, toast, useQuery, useSession } from "../shared/ui.tsx";
import { cartStore, useCart } from "./cart.ts";
import { locationStore, useLocation } from "./location.ts";

const TEST_CARDS: Array<[string, string]> = [
  ["tok_visa_test", "بطاقة اختبار — تنجح"],
  ["tok_decline", "بطاقة اختبار — مرفوضة"],
];

/** Cart + checkout. The breakdown shown is the server's authoritative quote; the same total is enforced at placement. */
export function Checkout({ go }: { go: (r: string) => void }) {
  const authed = !!useSession();
  const cart = useCart();
  const loc = useLocation();
  const addresses = useQuery(authed ? "/me/addresses" : null);
  const loyalty = useQuery(authed ? "/me/loyalty" : null);
  const [promo, setPromo] = useState("");
  const [appliedPromo, setAppliedPromo] = useState<string | undefined>();
  const [usePoints, setUsePoints] = useState(false);
  const [card, setCard] = useState(TEST_CARDS[0]![0]);
  const [notes, setNotes] = useState("");
  const [quote, setQuote] = useState<any>(null);
  const [qErr, setQErr] = useState<ApiError | null>(null);
  const [placing, setPlacing] = useState(false);
  const [idemKey] = useState(uuid);

  // Pick the default saved address once loaded.
  useEffect(() => {
    const list = addresses.data?.addresses;
    if (list?.length && !loc.addressId) {
      const a = list.find((x: any) => x.is_default) ?? list[0];
      locationStore.set({ lat: a.lat, lng: a.lng, label: a.label, addressId: a.id });
    }
  }, [addresses.data]);

  const points = usePoints ? Math.min(loyalty.data?.balance ?? 0, 100_000) : 0;
  useEffect(() => {
    if (!cart.lines.length || !cart.restaurantId) return;
    let live = true;
    setQErr(null);
    post("/checkout/quote", {
      restaurantId: cart.restaurantId,
      lines: cart.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, optionIds: l.optionIds })),
      ...(loc.addressId && authed ? { addressId: loc.addressId } : { dropoff: { lat: loc.lat, lng: loc.lng } }),
      ...(appliedPromo ? { promoCode: appliedPromo } : {}),
      ...(points >= 500 ? { redeemPoints: points } : {}),
    })
      .then((r) => live && setQuote(r.quote))
      .catch((e) => live && (setQErr(e), setQuote(null)));
    return () => {
      live = false;
    };
  }, [JSON.stringify(cart.lines), loc.addressId, loc.lat, appliedPromo, points, authed]);

  if (!cart.lines.length)
    return (
      <>
        <div className="topbar"><h1>{t("السلة")}</h1></div>
        <div className="screen"><Empty title={t("السلة فارغة")} body={t("شاهد الأطباق في اكتشف وأضف ما يعجبك بلمسة.")} action={<button className="btn primary" onClick={() => go("feed")}>{t("اكتشف")}</button>} /></div>
      </>
    );

  const place = async () => {
    if (!authed) return go("account");
    setPlacing(true);
    try {
      const r = await post(
        "/orders",
        {
          restaurantId: cart.restaurantId,
          lines: cart.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, optionIds: l.optionIds })),
          ...(loc.addressId ? { addressId: loc.addressId } : { dropoff: { lat: loc.lat, lng: loc.lng } }),
          ...(appliedPromo ? { promoCode: appliedPromo } : {}),
          ...(points >= 500 && quote?.points?.redeemed ? { redeemPoints: points } : {}),
          paymentToken: card,
          expectedTotal: quote?.pricing.total,
          ...(cart.videoId ? { videoId: cart.videoId } : {}),
          ...(notes ? { notes } : {}),
        },
        { "idempotency-key": idemKey },
      );
      cartStore.clear();
      go(`o/${r.orderId}`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setPlacing(false);
    }
  };

  const p = quote?.pricing;
  const blocked = quote && !quote.coverage.eligible;
  return (
    <>
      <div className="topbar"><h1>{t("إتمام الطلب")}</h1></div>
      <div className="screen stack lg">
        <section className="panel tight stack">
          <div className="row between">
            <h3>{cart.restaurantNameAr}</h3>
            <button className="btn sm ghost danger" onClick={() => cartStore.clear()}>إفراغ</button>
          </div>
          {cart.lines.map((l) => (
            <div key={l.key} className="row" style={{ alignItems: "flex-start" }}>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{L(l)}</div>
                {l.optionsLabel && <div className="xs muted">{l.optionsLabel}</div>}
                <div className="small num">{sar(l.unitPrice * l.qty)}</div>
              </div>
              <div className="stepper">
                <button aria-label="زيادة" onClick={() => cartStore.setQty(l.key, l.qty + 1)}>+</button>
                <span className="num">{l.qty}</span>
                <button aria-label="إنقاص" onClick={() => cartStore.setQty(l.key, l.qty - 1)}>−</button>
              </div>
            </div>
          ))}
        </section>

        <section className="panel tight stack">
          <h4>{t("عنوان التوصيل")}</h4>
          {authed && addresses.data?.addresses?.length ? (
            <div className="chips">
              {addresses.data.addresses.map((a: any) => (
                <button key={a.id} className="chip" aria-pressed={loc.addressId === a.id} onClick={() => locationStore.set({ lat: a.lat, lng: a.lng, label: a.label, addressId: a.id })}>
                  {a.label} · {a.district}
                </button>
              ))}
            </div>
          ) : (
            <p className="small row"><Icon.pin size={18} /> {loc.label}</p>
          )}
          {quote && (
            <p className="small muted">
              يصلك خلال <span className="num">{quote.coverage.etaRange[0]}–{quote.coverage.etaRange[1]}</span> دقيقة · <span className="num">{quote.coverage.roadDistanceKm.toFixed(1)}</span> كم
              {quote.coverage.routeSource === "heuristic" && <span className="xs"> (تقدير)</span>}
            </p>
          )}
          {blocked && <div className="notice bad">{quote.coverage.reasons[0]?.ar}</div>}
        </section>

        <section className="panel tight stack">
          <div className="row">
            <input className="input grow" placeholder={t("كود الخصم")} value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} aria-label={t("كود الخصم")} />
            <button className="btn" disabled={!promo} onClick={() => setAppliedPromo(promo || undefined)}>{t("تطبيق")}</button>
          </div>
          {quote?.promo && <p className={`small ${quote.promo.applied ? "" : "error-text"}`}>{quote.promo.applied ? `تم تطبيق ${quote.promo.code}` : quote.promo.reasonAr}</p>}
          {authed && (loyalty.data?.balance ?? 0) >= 500 && (
            <label className="row small" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={usePoints} onChange={(e) => setUsePoints(e.target.checked)} />
              {t("استخدم نقاطي")} (<span className="num">{loyalty.data.balance}</span> نقطة)
            </label>
          )}
          {quote?.points?.error && <p className="small error-text">لا يمكن استخدام النقاط على هذا الطلب</p>}
        </section>

        <section className="panel tight stack">
          {!p && !qErr && <Skeleton n={4} />}
          {qErr && <div className="notice bad">{qErr.message}</div>}
          {p && (
            <div className="bill">
              {p.lines.filter((l: any) => l.code !== "total").map((l: any) => (
                <div key={l.code} className={`line ${l.amount < 0 ? "minus" : ""} ${l.informational ? "info" : ""}`}>
                  <span>{L(l, "label")}</span>
                  <span className="num">{sar(l.amount)}</span>
                </div>
              ))}
              <div className="line total"><span>الإجمالي</span><span className="num">{sar(p.total)}</span></div>
              {quote.plus.member && !p.plus.eligible && p.plus.reasons.includes("below_minimum_basket") && (
                <div className="notice">أضف <span className="num">{sar(p.plus.amountToQualify)}</span> ليصبح التوصيل الأساسي مجانياً مع أبو9+</div>
              )}
              {!quote.plus.member && p.basicDeliveryFee > 0 && (
                <button className="notice info" style={{ border: 0, textAlign: "start", cursor: "pointer" }} onClick={() => go("plus")}>
                  مع أبو9+ توفّر <span className="num">{sar(p.basicDeliveryFee)}</span> على هذا الطلب. اعرف المزيد
                </button>
              )}
            </div>
          )}
        </section>

        <section className="panel tight stack">
          <h4>{t("طريقة الدفع")}</h4>
          <p className="xs muted">بوابة الدفع في هذه النسخة وهمية للاختبار — لا تُخصم أي مبالغ.</p>
          {TEST_CARDS.map(([tok, label]) => (
            <label className="opt" key={tok}>
              <input type="radio" name="card" checked={card === tok} onChange={() => setCard(tok)} />
              <span>{label}</span>
            </label>
          ))}
          <textarea className="input" rows={2} placeholder="ملاحظات للمطعم (اختياري)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </section>

        <button className="btn primary lg block" disabled={!quote || blocked || placing} onClick={() => void place()}>
          {authed ? `${t("تأكيد الطلب والدفع")}${p ? ` · ${sar(p.total)}` : ""}` : "سجّل الدخول لإتمام الطلب"}
        </button>
      </div>
    </>
  );
}
