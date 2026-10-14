import { Icon, ToastHost, mount, useHashRoute, useSession } from "../shared/ui.tsx";
import { t, useLocale } from "../shared/i18n.ts";
import { Feed } from "./Feed.tsx";
import { RestaurantPage, Restaurants } from "./Restaurants.tsx";
import { Checkout } from "./Checkout.tsx";
import { OrderTracking, OrdersList } from "./Orders.tsx";
import { Account, PlusPage } from "./Account.tsx";
import { cartCount, useCart } from "./cart.ts";

function App() {
  useLocale();
  const authed = !!useSession();
  const [route, go] = useHashRoute("feed");
  const cart = useCart();
  const [head, arg] = route.split("/");
  const needsAuth = ["orders", "o", "plus"].includes(head!);
  let screen;
  if (needsAuth && !authed) screen = <Account go={go} />;
  else if (head === "restaurants") screen = <Restaurants go={go} />;
  else if (head === "r" && arg) screen = <RestaurantPage slug={arg} go={go} />;
  else if (head === "cart") screen = <Checkout go={go} />;
  else if (head === "orders") screen = <OrdersList go={go} />;
  else if (head === "o" && arg) screen = <OrderTracking id={arg} go={go} />;
  else if (head === "account") screen = <Account go={go} />;
  else if (head === "plus") screen = <PlusPage go={go} />;
  else screen = <Feed go={go} />;

  const tab = head === "r" ? "restaurants" : head === "o" ? "orders" : head === "plus" ? "account" : head;
  const dark = head === "feed" || !head;
  const tabs: Array<[string, string, (typeof Icon)[keyof typeof Icon]]> = [
    ["feed", t("اكتشف"), Icon.play],
    ["restaurants", t("المطاعم"), Icon.store],
    ["cart", t("السلة"), Icon.bag],
    ["orders", t("طلباتي"), Icon.receipt],
    ["account", t("حسابي"), Icon.user],
  ];
  const n = cartCount(cart);
  return (
    <div className="phone">
      {screen}
      <nav className={`tabbar ${dark ? "dark" : ""}`} aria-label="التنقل">
        {tabs.map(([k, label, Ico]) => (
          <button key={k} aria-current={tab === k ? "page" : undefined} onClick={() => go(k)}>
            <Ico />
            {label}
            {k === "cart" && n > 0 && <span className="dot num">{n}</span>}
          </button>
        ))}
      </nav>
      <ToastHost />
    </div>
  );
}

mount(App);
