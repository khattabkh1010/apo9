// Cart state (client-side; prices are re-quoted by the server at checkout — never trusted from here).
import { useSyncExternalStore } from "react";
import { session } from "../shared/api.ts";

export interface CartLine {
  key: string;
  itemId: string;
  nameAr: string;
  nameEn: string;
  qty: number;
  optionIds: string[];
  optionsLabel: string;
  unitPrice: number;
}
export interface Cart {
  restaurantId: string | null;
  restaurantSlug: string | null;
  restaurantNameAr: string | null;
  videoId: string | null;
  lines: CartLine[];
  /** Set when this cart is a locked group order: the server places the group's items (authoritative). */
  groupCartId?: string | null;
  groupCode?: string | null;
}

const KEY = "abu9.cart";
const empty: Cart = { restaurantId: null, restaurantSlug: null, restaurantNameAr: null, videoId: null, lines: [] };
let cart: Cart = (() => {
  try {
    return JSON.parse(session.store.get(KEY) ?? "null") ?? empty;
  } catch {
    return empty;
  }
})();
const subs = new Set<() => void>();
function set(c: Cart) {
  cart = c;
  session.store.set(KEY, JSON.stringify(c));
  subs.forEach((s) => s());
}

export const cartStore = {
  get: () => cart,
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
  /** Returns false (without changing anything) when the item is from a different restaurant. */
  add(r: { id: string; slug: string; nameAr: string }, line: Omit<CartLine, "key">, videoId?: string | null): boolean {
    if (cart.restaurantId && cart.restaurantId !== r.id && cart.lines.length) return false;
    const key = `${line.itemId}:${[...line.optionIds].sort().join(",")}`;
    const existing = cart.lines.find((l) => l.key === key);
    const lines = existing ? cart.lines.map((l) => (l.key === key ? { ...l, qty: Math.min(50, l.qty + line.qty) } : l)) : [...cart.lines, { ...line, key }];
    set({ restaurantId: r.id, restaurantSlug: r.slug, restaurantNameAr: r.nameAr, videoId: videoId ?? cart.videoId, lines });
    return true;
  },
  setQty(key: string, qty: number) {
    const lines = qty <= 0 ? cart.lines.filter((l) => l.key !== key) : cart.lines.map((l) => (l.key === key ? { ...l, qty } : l));
    set(lines.length ? { ...cart, lines } : empty);
  },
  clear: () => set(empty),
  /** Load a locked group cart for checkout by the host. Replaces the personal cart. */
  loadGroup(g: { id: string; code: string; restaurant_id: string; slug: string; restaurant_name_ar: string }, items: Array<{ item_id: string; name_ar: string; name_en: string; qty: number; price: number; option_ids: string[]; options: Array<{ nameAr: string; priceDelta: number }> }>) {
    set({
      restaurantId: g.restaurant_id, restaurantSlug: g.slug, restaurantNameAr: g.restaurant_name_ar, videoId: null, groupCartId: g.id, groupCode: g.code,
      lines: items.map((i, n) => ({
        key: `g${n}`, itemId: i.item_id, nameAr: i.name_ar, nameEn: i.name_en, qty: i.qty, optionIds: i.option_ids,
        optionsLabel: i.options.map((o) => o.nameAr).join("، "), unitPrice: i.price + i.options.reduce((a, o) => a + o.priceDelta, 0),
      })),
    });
  },
};

// Active group order the customer is adding to (by code). Items go to the shared server cart, not the personal cart.
const GKEY = "abu9.group";
let group: { code: string; restaurantId: string } | null = (() => {
  try {
    return JSON.parse(session.store.get(GKEY) ?? "null");
  } catch {
    return null;
  }
})();
const gsubs = new Set<() => void>();
export const groupStore = {
  get: () => group,
  set(g: { code: string; restaurantId: string } | null) {
    group = g;
    session.store.set(GKEY, g ? JSON.stringify(g) : null);
    gsubs.forEach((f) => f());
  },
  subscribe(fn: () => void) {
    gsubs.add(fn);
    return () => gsubs.delete(fn);
  },
};
export function useGroup() {
  return useSyncExternalStore(groupStore.subscribe, groupStore.get);
}

export function useCart(): Cart {
  return useSyncExternalStore(cartStore.subscribe, cartStore.get);
}
export const cartCount = (c: Cart) => c.lines.reduce((a, l) => a + l.qty, 0);
