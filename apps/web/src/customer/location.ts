// Delivery location: the customer's selected saved address, else a demo point in Olaya.
import { useSyncExternalStore } from "react";
import { session } from "../shared/api.ts";

export interface Loc {
  lat: number;
  lng: number;
  label: string;
  addressId: string | null;
}
const KEY = "abu9.location";
const DEMO: Loc = { lat: 24.693, lng: 46.688, label: "العليا (موقع تجريبي)", addressId: null };
let loc: Loc = (() => {
  try {
    return JSON.parse(session.store.get(KEY) ?? "null") ?? DEMO;
  } catch {
    return DEMO;
  }
})();
const subs = new Set<() => void>();
export const locationStore = {
  set(l: Loc) {
    loc = l;
    session.store.set(KEY, JSON.stringify(l));
    subs.forEach((s) => s());
  },
  get: () => loc,
};
export function useLocation(): Loc {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => loc,
  );
}
