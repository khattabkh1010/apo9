import { useMemo, useState } from "react";
import { L, sar, t } from "../shared/i18n.ts";
import { Sheet } from "../shared/ui.tsx";
import { post } from "../shared/api.ts";
import { cartStore, groupStore } from "./cart.ts";

export interface MenuItem {
  id: string;
  name_ar: string;
  name_en: string;
  description_ar?: string | null;
  price: number;
  calories?: number | null;
  is_available: boolean;
  modifierGroups: Array<{ id: string; name_ar: string; name_en: string; min_select: number; max_select: number; options: Array<{ id: string; name_ar: string; name_en: string; price_delta: number; is_available: boolean }> }>;
}

/** Product customisation: validates min/max per modifier group before it can be added. */
export function ItemSheet({ item, restaurant, videoId, onClose, onAdded }: { item: MenuItem; restaurant: { id: string; slug: string; name_ar: string }; videoId?: string | null; onClose: () => void; onAdded: (ok: boolean, group?: boolean, error?: string) => void }) {
  const [sel, setSel] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(item.modifierGroups.map((g) => [g.id, g.min_select === 1 && g.max_select === 1 && g.options[0] ? [g.options.find((o) => o.is_available)?.id ?? g.options[0].id] : []])),
  );
  const [qty, setQty] = useState(1);
  const chosen = item.modifierGroups.flatMap((g) => g.options.filter((o) => sel[g.id]?.includes(o.id)));
  const unit = item.price + chosen.reduce((a, o) => a + o.price_delta, 0);
  const invalid = useMemo(() => item.modifierGroups.find((g) => (sel[g.id]?.length ?? 0) < g.min_select), [sel, item]);

  const toggle = (gid: string, oid: string, single: boolean, max: number) =>
    setSel((s) => {
      const cur = s[gid] ?? [];
      if (single) return { ...s, [gid]: [oid] };
      if (cur.includes(oid)) return { ...s, [gid]: cur.filter((x) => x !== oid) };
      if (cur.length >= max) return s;
      return { ...s, [gid]: [...cur, oid] };
    });

  const add = async () => {
    const g = groupStore.get();
    if (g && g.restaurantId === restaurant.id) {
      // Group order: the item goes to the shared server-side cart.
      try {
        await post(`/group-carts/${g.code}/items`, { itemId: item.id, qty, optionIds: chosen.map((o) => o.id) });
        onAdded(true, true);
      } catch (e) {
        onAdded(false, true, (e as Error).message);
      }
      return;
    }
    const ok = cartStore.add(
      { id: restaurant.id, slug: restaurant.slug, nameAr: restaurant.name_ar },
      { itemId: item.id, nameAr: item.name_ar, nameEn: item.name_en, qty, optionIds: chosen.map((o) => o.id), optionsLabel: chosen.map((o) => o.name_ar).join("، "), unitPrice: unit },
      videoId,
    );
    onAdded(ok);
  };

  return (
    <Sheet onClose={onClose} label={L(item)}>
      <div className="stack lg">
        <div className="stack" style={{ gap: 4 }}>
          <h2>{L(item)}</h2>
          {item.description_ar && <p className="muted">{item.description_ar}</p>}
          <div className="row small muted">
            <span className="num" style={{ color: "var(--c-ink)", fontWeight: 700 }}>{sar(item.price)}</span>
            {item.calories ? <span>{item.calories} سعرة</span> : null}
          </div>
        </div>
        {item.modifierGroups.map((g) => {
          const single = g.max_select === 1;
          return (
            <fieldset key={g.id} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="row between" style={{ width: "100%" }}>
                <h4>{L(g)}</h4>
                <span className={`badge ${g.min_select > 0 ? "warn" : ""}`}>{g.min_select > 0 ? "مطلوب" : `اختياري · حتى ${g.max_select}`}</span>
              </legend>
              {g.options.map((o) => (
                <label key={o.id} className="opt" style={o.is_available ? undefined : { opacity: 0.4 }}>
                  <input type={single ? "radio" : "checkbox"} name={g.id} disabled={!o.is_available} checked={sel[g.id]?.includes(o.id) ?? false} onChange={() => toggle(g.id, o.id, single, g.max_select)} />
                  <span className="grow">{L(o)}</span>
                  {o.price_delta > 0 && <span className="num small">{sar(o.price_delta, { sign: true })}</span>}
                </label>
              ))}
            </fieldset>
          );
        })}
        <div className="row between">
          <div className="stepper" aria-label="الكمية">
            <button aria-label="زيادة" onClick={() => setQty((q) => Math.min(50, q + 1))}>+</button>
            <span className="num">{qty}</span>
            <button aria-label="إنقاص" onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button>
          </div>
          <button className="btn primary lg grow" disabled={!item.is_available || !!invalid} onClick={() => void add()}>
            {invalid ? `اختر ${L(invalid)}` : `${t("أضف للسلة")} · ${sar(unit * qty)}`}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
