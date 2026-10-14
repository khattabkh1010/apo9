import { forbidden, unauthorized, type Ctx, type Principal } from "../http/router.ts";

export const GLOBAL_SCOPE = "00000000-0000-0000-0000-000000000000";

export type Permission =
  | "orders.read_all"
  | "orders.intervene"
  | "dispatch.override"
  | "refunds.issue"
  | "refunds.issue_large"
  | "claims.resolve"
  | "pricing.configure"
  | "zones.configure"
  | "settings.configure"
  | "content.moderate"
  | "creators.approve"
  | "promotions.approve"
  | "finance.ledger.read"
  | "finance.settlements"
  | "finance.reconcile"
  | "audit.read"
  | "users.manage"
  | "logistics.manage_all"
  | "restaurants.manage_all"
  | "analytics.read";

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  ops_agent: ["orders.read_all", "orders.intervene", "refunds.issue", "content.moderate", "analytics.read"],
  ops_manager: [
    "orders.read_all", "orders.intervene", "dispatch.override", "refunds.issue", "refunds.issue_large", "claims.resolve",
    "zones.configure", "content.moderate", "creators.approve", "promotions.approve", "logistics.manage_all",
    "restaurants.manage_all", "analytics.read",
  ],
  finance: ["finance.ledger.read", "finance.settlements", "finance.reconcile", "audit.read", "analytics.read", "claims.resolve"],
  admin: [
    "orders.read_all", "orders.intervene", "dispatch.override", "refunds.issue", "refunds.issue_large", "claims.resolve",
    "pricing.configure", "zones.configure", "settings.configure", "content.moderate", "creators.approve", "promotions.approve",
    "finance.ledger.read", "finance.settlements", "finance.reconcile", "audit.read", "users.manage", "logistics.manage_all",
    "restaurants.manage_all", "analytics.read",
  ],
};

export function permissionsOf(p: Principal): Set<Permission> {
  const s = new Set<Permission>();
  for (const r of p.roles) if (r.scopeType === "global") for (const perm of ROLE_PERMISSIONS[r.role] ?? []) s.add(perm);
  return s;
}

export function requireUser(ctx: Ctx): Principal {
  if (!ctx.principal) throw unauthorized();
  return ctx.principal;
}

export function hasPermission(p: Principal | null, perm: Permission): boolean {
  return !!p && permissionsOf(p).has(perm);
}

export function requirePermission(ctx: Ctx, perm: Permission): Principal {
  const p = requireUser(ctx);
  if (!permissionsOf(p).has(perm)) throw forbidden("missing_permission", `requires ${perm}`);
  return p;
}

export function hasRole(p: Principal, role: string, scopeType = "global", scopeId?: string): boolean {
  return p.roles.some((r) => r.role === role && r.scopeType === scopeType && (scopeId === undefined || r.scopeId === scopeId));
}

/** Restaurant owners/staff scoped to the restaurant, or platform operators. */
export function requireRestaurantAccess(ctx: Ctx, restaurantId: string): Principal {
  const p = requireUser(ctx);
  const ok =
    p.roles.some((r) => (r.role === "restaurant_owner" || r.role === "restaurant_staff") && r.scopeType === "restaurant" && r.scopeId === restaurantId) ||
    permissionsOf(p).has("restaurants.manage_all");
  if (!ok) throw forbidden("restaurant_access_denied");
  return p;
}

export function restaurantScopes(p: Principal): string[] {
  return p.roles.filter((r) => (r.role === "restaurant_owner" || r.role === "restaurant_staff") && r.scopeType === "restaurant").map((r) => r.scopeId);
}

export function requireLogisticsAccess(ctx: Ctx, companyId: string): Principal {
  const p = requireUser(ctx);
  const ok =
    p.roles.some((r) => (r.role === "logistics_admin" || r.role === "logistics_dispatcher") && r.scopeType === "logistics_company" && r.scopeId === companyId) ||
    permissionsOf(p).has("logistics.manage_all");
  if (!ok) throw forbidden("logistics_access_denied");
  return p;
}

export function logisticsScopes(p: Principal): string[] {
  return p.roles.filter((r) => (r.role === "logistics_admin" || r.role === "logistics_dispatcher") && r.scopeType === "logistics_company").map((r) => r.scopeId);
}
