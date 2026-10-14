import { useEffect, useState } from "react";
import { post, session } from "../shared/api.ts";
import { date, L, minutesUntil, sar, t, time } from "../shared/i18n.ts";
import { Empty, Icon, Loadable, Sadu, Sheet, StatusBadge, toast, useQuery } from "../shared/ui.tsx";

export function OrdersList({ go }: { go: (r: string) => void }) {
  const q = useQuery("/orders");
  return (
    <>
      <div className="topbar"><h1>{t("طلباتي")}</h1></div>
      <div className="screen">
        <Loadable q={q}>
          {(d) =>
            d.orders.length === 0 ? (
              <Empty title={t("لا توجد طلبات بعد")} body="أول طلب منك يبدأ من فيديو." action={<button className="btn primary" onClick={() => go("feed")}>{t("اكتشف")}</button>} />
            ) : (
              d.orders.map((o: any) => (
                <button key={o.id} className="rest" onClick={() => go(`o/${o.id}`)}>
                  <div className="logo" style={{ background: o.brand_color, width: 48, height: 48, fontSize: 18 }} aria-hidden="true">{o.restaurant_name_ar.slice(0, 1)}</div>
                  <div className="grow stack" style={{ gap: 2 }}>
                    <div className="row between"><strong>{o.restaurant_name_ar}</strong><StatusBadge s={o.status} /></div>
                    <div className="row xs muted between">
                      <span>#<span className="num">{o.number}</span> · {date(o.created_at)} · <span className="num">{o.item_count}</span> أصناف</span>
                      <span className="num" style={{ color: "var(--c-ink)", fontWeight: 700 }}>{sar(o.total)}</span>
                    </div>
                  </div>
                </button>
              ))
            )
          }
        </Loadable>
      </div>
    </>
  );
}

// Stages shown on the woven tracker band (one triangle pair per stage).
const STAGES = ["placed", "accepted", "preparing", "ready_for_pickup", "picked_up", "delivered"] as const;
const STAGE_TEXT: Record<string, string> = {
  pending_payment: "بانتظار تأكيد الدفع",
  placed: "أرسلنا طلبك للمطعم",
  accepted: "المطعم قبل طلبك",
  preparing: "يتم تحضير طلبك الآن",
  ready_for_pickup: "طلبك جاهز وينتظر المندوب",
  picked_up: "المندوب في الطريق إليك",
  delivered: "بالعافية! تم التوصيل",
  rejected: "اعتذر المطعم عن الطلب — لن يُخصم أي مبلغ",
  cancelled: "تم إلغاء الطلب",
  delivery_failed: "تعذّر التوصيل — فريق الدعم سيتواصل معك",
};

/** Live tracking: SSE stream for instant updates, plus a slow poll as a fallback. */
export function OrderTracking({ id, go }: { id: string; go: (r: string) => void }) {
  const q = useQuery(`/orders/${id}`, { poll: 15_000 });
  const [rate, setRate] = useState(false);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    if (!session.token) return;
    // Same-origin EventSource sends the httpOnly session cookie; no token in the URL.
    const es = new EventSource(`/api/v1/orders/${id}/stream`);
    es.addEventListener("update", () => void q.reload());
    return () => es.close();
  }, [id]);

  return (
    <Loadable q={q}>
      {(d) => {
        const o = d.order;
        const idx = STAGES.indexOf(o.status as (typeof STAGES)[number]);
        const filled = idx < 0 ? 0 : (idx + 1) * 2;
        const terminalBad = ["rejected", "cancelled", "delivery_failed"].includes(o.status);
        const eta = minutesUntil(o.eta_at);
        const del = d.delivery;
        // Schematic route: courier marker position between branch and customer (no map tiles offline).
        let progress = 0;
        if (del?.courierLocation) {
          const total = Math.hypot(o.branch_lat - o.dropoff_lat, o.branch_lng - o.dropoff_lng) || 1;
          const left = Math.hypot(del.courierLocation.lat - o.dropoff_lat, del.courierLocation.lng - o.dropoff_lng);
          progress = Math.max(0.05, Math.min(0.95, 1 - left / total));
        } else if (o.status === "delivered") progress = 1;
        return (
          <>
            <div className="topbar">
              <button className="btn ghost sm" onClick={() => go("orders")} aria-label="رجوع"><Icon.back /></button>
              <h1 className="grow">{t("تتبع الطلب")} #<span className="num">{o.number}</span></h1>
            </div>
            <div className="screen stack lg">
              <section className="panel stack lg">
                <div className="stack" style={{ gap: 4 }}>
                  <p className="small muted">{o.restaurant_name_ar}</p>
                  <h2 aria-live="polite">{STAGE_TEXT[o.status] ?? o.status}</h2>
                  {!terminalBad && o.status !== "delivered" && eta !== null && (
                    <p className="muted">الوصول المتوقع <span className="num" style={{ color: "var(--c-ink)", fontWeight: 700 }}>{time(o.eta_at)}</span>{eta > 0 && <> · بعد <span className="num">{eta}</span> دقيقة</>}</p>
                  )}
                </div>
                {!terminalBad && <Sadu total={12} on={filled} now={o.status !== "delivered"} />}
              </section>

              {o.status === "picked_up" && del?.dropoffCode && (
                <section className="panel stack" style={{ textAlign: "center" }}>
                  <p className="small muted">{t("أعطِ هذا الرمز للمندوب عند الاستلام")}</p>
                  <div className="track-code" aria-label={t("رمز التسليم")}>{del.dropoffCode}</div>
                </section>
              )}

              {del && !terminalBad && o.status !== "delivered" && (
                <section className="panel tight stack">
                  <div className="route" aria-label="مسار التوصيل">
                    <div className="path" />
                    <div className="pin" style={{ insetInlineEnd: 20, background: "#fff" }} title="المطعم"><Icon.store size={18} /></div>
                    <div className="pin" style={{ insetInlineStart: 20, background: "var(--c-sadu)", color: "#fff" }} title="أنت"><Icon.pin size={18} /></div>
                    {(o.status === "picked_up" || del.courierLocation) && (
                      <div className="courier" style={{ insetInlineEnd: `calc(${progress * 100}% - ${progress * 40}px + 18px)` }}><Icon.bike size={20} /></div>
                    )}
                  </div>
                  <div className="row between small">
                    <span>{del.courierName ? `المندوب: ${del.courierName}` : "نبحث لك عن أقرب مندوب"}</span>
                    {o.route_source === "heuristic" && <span className="xs muted">المسار تقديري</span>}
                  </div>
                </section>
              )}

              <section className="panel tight stack">
                {d.items.map((i: any, k: number) => (
                  <div className="row between small" key={k}>
                    <span><span className="num">{i.qty}×</span> {L(i)}</span>
                    <span className="num">{sar(i.line_total)}</span>
                  </div>
                ))}
                <hr className="rule" />
                <div className="bill">
                  {o.pricing.lines.filter((l: any) => l.code !== "total").map((l: any) => (
                    <div key={l.code} className={`line ${l.amount < 0 ? "minus" : ""} ${l.informational ? "info" : ""}`}><span>{L(l, "label")}</span><span className="num">{sar(l.amount)}</span></div>
                  ))}
                  <div className="line total"><span>الإجمالي</span><span className="num">{sar(o.total)}</span></div>
                </div>
              </section>

              <div className="row">
                {o.status === "placed" && (
                  <button className="btn danger grow" onClick={async () => { await post(`/orders/${id}/cancel`).then(() => q.reload()).catch((e) => toast(e.message, true)); }}>إلغاء الطلب</button>
                )}
                {o.status === "delivered" && <button className="btn primary grow" onClick={() => setRate(true)}>{t("قيّم طلبك")}</button>}
                <button className="btn grow" onClick={() => setHelp(true)}>{t("تواصل مع الدعم")}</button>
              </div>
            </div>
            {rate && <RateSheet orderId={id} onClose={() => setRate(false)} />}
            {help && <SupportSheet orderId={id} total={o.total} onClose={() => setHelp(false)} />}
          </>
        );
      }}
    </Loadable>
  );
}

function Stars({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="row" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} role="radio" aria-checked={value === n} className="btn ghost" style={{ fontSize: 28, color: n <= value ? "var(--c-saffron)" : "var(--c-line)", padding: 4 }} onClick={() => onChange(n)}>★</button>
      ))}
    </div>
  );
}

function RateSheet({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const [r, setR] = useState(0);
  const [c, setC] = useState(0);
  const [comment, setComment] = useState("");
  return (
    <Sheet onClose={onClose} label="التقييم">
      <div className="stack lg">
        <h2>كيف كان طلبك؟</h2>
        <div className="stack"><h4>الأكل</h4><Stars value={r} onChange={setR} label="تقييم المطعم" /></div>
        <div className="stack"><h4>التوصيل</h4><Stars value={c} onChange={setC} label="تقييم المندوب" /></div>
        <textarea className="input" rows={3} placeholder="ملاحظة (اختياري)" value={comment} onChange={(e) => setComment(e.target.value)} />
        <button className="btn primary lg" disabled={!r} onClick={async () => {
          try {
            await post(`/orders/${orderId}/rating`, { restaurantStars: r, ...(c ? { courierStars: c } : {}), ...(comment ? { comment } : {}) });
            toast("شكراً، وصلنا تقييمك");
            onClose();
          } catch (e) { toast((e as Error).message, true); }
        }}>أرسل التقييم</button>
      </div>
    </Sheet>
  );
}

function SupportSheet({ orderId, total, onClose }: { orderId: string; total: number; onClose: () => void }) {
  const reasons = useQuery("/support/reasons");
  const [reason, setReason] = useState("");
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [done, setDone] = useState<any>(null);
  return (
    <Sheet onClose={onClose} label="الدعم">
      {done ? (
        <div className="stack lg">
          <h2>{done.autoResolved ? "تم الاسترداد" : "استلمنا طلبك"}</h2>
          <p className="muted">{done.autoResolved ? "أعدنا المبلغ لوسيلة الدفع. يظهر خلال أيام عمل حسب البنك." : "سيراجع فريق الدعم طلبك ويرد عليك قريباً."}</p>
          <button className="btn primary" onClick={onClose}>تم</button>
        </div>
      ) : (
        <div className="stack lg">
          <h2>وش المشكلة؟</h2>
          <Loadable q={reasons}>
            {(d) => (
              <div>
                {d.reasons.filter((r: any) => !["customer_unreachable", "wrong_address"].includes(r.code)).map((r: any) => (
                  <label key={r.code} className="opt"><input type="radio" name="reason" checked={reason === r.code} onChange={() => setReason(r.code)} /><span>{r.ar}</span></label>
                ))}
              </div>
            )}
          </Loadable>
          <div className="field">
            <label htmlFor="amt">قيمة الأصناف المتأثرة (ر.س)</label>
            <input id="amt" className="input num" inputMode="decimal" placeholder={`حتى ${(total / 100).toFixed(2)}`} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <textarea className="input" rows={3} placeholder="اشرح باختصار" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <button className="btn primary lg" disabled={!reason} onClick={async () => {
            try {
              const r = await post("/support/tickets", { orderId, reasonCode: reason, description: desc || undefined, ...(amount ? { affectedAmount: Math.round(Number(amount) * 100) } : {}) });
              setDone(r);
            } catch (e) { toast((e as Error).message, true); }
          }}>أرسل</button>
        </div>
      )}
    </Sheet>
  );
}
