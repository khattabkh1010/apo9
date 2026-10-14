// Arabic-first i18n. Arabic is the source language; English mirrors it.
import { useSyncExternalStore } from "react";
import { session } from "./api.ts";

export type Locale = "ar" | "en";
let locale: Locale = (session.store.get("abu9.locale") as Locale) || "ar";
const subs = new Set<() => void>();

function apply() {
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
}
apply();

export function setLocale(l: Locale) {
  locale = l;
  session.store.set("abu9.locale", l);
  apply();
  subs.forEach((s) => s());
}

export function useLocale(): Locale {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => locale,
  );
}

const EN: Record<string, string> = {
  اكتشف: "Discover",
  المطاعم: "Restaurants",
  السلة: "Cart",
  طلباتي: "Orders",
  حسابي: "Account",
  "أضف للسلة": "Add to cart",
  "تمت الإضافة": "Added",
  "ابحث عن مطعم أو طبق": "Search a restaurant or dish",
  "يوصّل لك": "Delivers to you",
  "خارج منطقتك": "Outside your area",
  "اختر الإضافات": "Choose options",
  "إتمام الطلب": "Checkout",
  "تأكيد الطلب والدفع": "Place order and pay",
  "عنوان التوصيل": "Delivery address",
  "كود الخصم": "Promo code",
  تطبيق: "Apply",
  "استخدم نقاطي": "Use my points",
  "طريقة الدفع": "Payment method",
  "السلة فارغة": "Your cart is empty",
  "شاهد الأطباق في اكتشف وأضف ما يعجبك بلمسة.": "Watch dishes in Discover and add what you like in one tap.",
  "رمز التسليم": "Handover code",
  "أعطِ هذا الرمز للمندوب عند الاستلام": "Give this code to the courier at handover",
  "قيّم طلبك": "Rate your order",
  "تسجيل الخروج": "Log out",
  "رقم الجوال": "Mobile number",
  "أرسل الرمز": "Send code",
  "رمز التحقق": "Verification code",
  دخول: "Log in",
  "لغة التطبيق": "App language",
  "تواصل مع الدعم": "Contact support",
  عناويني: "My addresses",
  نقاطي: "My points",
  "لا توجد طلبات بعد": "No orders yet",
  "اطلب": "Order",
  "تتبع الطلب": "Track order",
  "عنوان جديد": "New address",
  "حُفظ العنوان": "Address saved",
  "استخدم موقعي الحالي": "Use my current location",
  الحي: "District",
  "الشارع والتفاصيل": "Street and details",
  "المبنى / الشقة": "Building / apartment",
  "ملاحظات للمندوب": "Notes for the courier",
  "العنوان الافتراضي": "Default address",
  "حفظ العنوان": "Save address",
  إضافة: "Add",
  "لا توجد عناوين محفوظة.": "No saved addresses.",
  افتراضي: "Default",
  المفضلة: "Favourites",
  "لا توجد مطاعم مفضلة بعد": "No favourite restaurants yet",
  "اضغط على القلب في صفحة أي مطعم لحفظه هنا.": "Tap the heart on any restaurant to save it here.",
  الإشعارات: "Notifications",
  "لا توجد إشعارات": "No notifications",
  جديد: "New",
  "طلب جماعي": "Group order",
  "طلب جماعي مع الأصدقاء": "Group order with friends",
  مفتوح: "Open",
  "تم الطلب": "Ordered",
  مقفل: "Locked",
  الرمز: "Code",
  ينتهي: "Expires",
  "أنت المضيف وتدفع الطلب كاملاً": "You are the host and pay for the whole order",
  "المضيف يدفع الطلب": "The host pays for the order",
  "مشاركة الرابط": "Share link",
  "نُسخ الرابط": "Link copied",
  "أضف المزيد من المنيو": "Add more from the menu",
  "انضم وأضف طلبك": "Join and add your order",
  "لم يُضف أحد شيئاً بعد.": "Nobody has added anything yet.",
  "تقدير قيمة الأكل": "Estimated food value",
  "السعر النهائي والتوصيل يُحسبان عند الدفع.": "Final price and delivery are calculated at checkout.",
  "إقفال الطلب الجماعي والانتقال للدفع؟": "Lock the group order and go to checkout?",
  "لن يتمكن أحد من الإضافة بعد الإقفال.": "Nobody can add items after locking.",
  "إقفال والدفع": "Lock and pay",
  "الخروج من الطلب الجماعي": "Leave the group order",
  "تضيف إلى طلب جماعي": "Adding to group order",
  "عرض السلة المشتركة": "View shared cart",
  "أُضيف للطلب الجماعي": "Added to the group order",
};

export function t(ar: string): string {
  return locale === "en" ? (EN[ar] ?? ar) : ar;
}

/** Pick the localized field from an API row (name_ar / name_en, nameAr / nameEn). */
export function L(row: Record<string, any> | null | undefined, base = "name"): string {
  if (!row) return "";
  const snake = locale === "en" ? row[`${base}_en`] : row[`${base}_ar`];
  const camel = locale === "en" ? row[`${base}En`] : row[`${base}Ar`];
  return snake ?? camel ?? row[`${base}_ar`] ?? row[`${base}Ar`] ?? "";
}

export function sar(h: number | string | null | undefined, opts: { sign?: boolean } = {}): string {
  const v = Number(h ?? 0) / 100;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: v % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  const sign = v < 0 ? "−" : opts.sign && v > 0 ? "+" : "";
  return locale === "en" ? `${sign}SAR ${s}` : `${sign}${s} ر.س`;
}

const riyadhTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Riyadh" });
const riyadhDate = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "short", timeZone: "Asia/Riyadh" });
export const time = (d: string | Date | null | undefined) => (d ? riyadhTime.format(new Date(d)) : "—");
export const date = (d: string | Date | null | undefined) => (d ? riyadhDate.format(new Date(d)) : "—");
export function minutesUntil(d: string | Date | null | undefined): number | null {
  if (!d) return null;
  return Math.round((new Date(d).getTime() - Date.now()) / 60000);
}
