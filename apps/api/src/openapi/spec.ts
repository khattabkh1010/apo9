import type { Router } from "../http/router.ts";

/**
 * OpenAPI 3.1 document generated from the live route table, so it can never drift from what the
 * server actually exposes. Request/response bodies for the core commerce flow are described
 * explicitly below; remaining routes are listed with params, auth and tags.
 */
const TAGS: Array<[RegExp, string]> = [
  [/^\/api\/v1\/auth|^\/api\/v1\/me(\/|$)(?!loyalty|favorites)/, "Identity"],
  [/^\/api\/v1\/(restaurants|feed|videos|zones|me\/favorites)/, "Catalog & Discovery"],
  [/^\/api\/v1\/(checkout|orders|support|group-carts)/, "Ordering"],
  [/^\/api\/v1\/restaurant/, "Restaurant Portal"],
  [/^\/api\/v1\/courier/, "Courier App"],
  [/^\/api\/v1\/logistics|^\/api\/v1\/admin\/capacity/, "Logistics Portal"],
  [/^\/api\/v1\/(creator|media)/, "Creator Portal"],
  [/^\/api\/v1\/(plus|me\/loyalty)/, "ABU9+ & Loyalty"],
  [/^\/api\/v1\/payments/, "Payments"],
  [/^\/api\/v1\/admin/, "Admin & Operations"],
];

const PUBLIC = [/^\/api\/v1\/auth\/otp/, /^\/api\/v1\/restaurants/, /^\/api\/v1\/feed/, /^\/api\/v1\/zones/, /^\/api\/v1\/payments\/webhooks/, /^\/healthz/, /^\/api\/v1\/support\/reasons/, /^\/api\/v1\/checkout\/quote/, /^\/api\/v1\/videos/];

const Money = { type: "integer", description: "Halalas (1 SAR = 100). VAT-inclusive for consumer amounts." };
const CartLine = { type: "object", required: ["itemId", "qty"], properties: { itemId: { type: "string", format: "uuid" }, qty: { type: "integer", minimum: 1, maximum: 50 }, optionIds: { type: "array", items: { type: "string", format: "uuid" } }, note: { type: "string", maxLength: 140 } } };
const QuoteRequest = {
  type: "object",
  required: ["lines"],
  properties: {
    restaurantId: { type: "string", format: "uuid" },
    branchId: { type: "string", format: "uuid" },
    lines: { type: "array", items: CartLine, minItems: 1 },
    addressId: { type: "string", format: "uuid" },
    dropoff: { type: "object", properties: { lat: { type: "number" }, lng: { type: "number" } } },
    promoCode: { type: "string" },
    redeemPoints: { type: "integer" },
  },
};
const PriceLine = { type: "object", properties: { code: { type: "string", enum: ["food_subtotal", "food_discount", "basic_delivery_fee", "additional_distance_fee", "abu9_plus_discount", "service_fee", "small_order_fee", "vat_included", "total"] }, amount: Money, labelAr: { type: "string" }, labelEn: { type: "string" }, informational: { type: "boolean" } } };

const BODIES: Record<string, { request?: unknown; response?: unknown; headers?: Array<{ name: string; required: boolean; description: string }> }> = {
  "POST /api/v1/auth/otp/request": { request: { type: "object", required: ["phone"], properties: { phone: { type: "string", example: "0551234567" } } }, response: { type: "object", properties: { challengeId: { type: "string" }, expiresInSec: { type: "integer" }, devCode: { type: "string", description: "DEV ONLY" } } } },
  "POST /api/v1/auth/otp/verify": { request: { type: "object", required: ["challengeId", "code"], properties: { challengeId: { type: "string" }, code: { type: "string", pattern: "^\\d{6}$" }, name: { type: "string" } } }, response: { type: "object", properties: { token: { type: "string" }, userId: { type: "string" }, isNew: { type: "boolean" } } } },
  "POST /api/v1/checkout/quote": { request: QuoteRequest, response: { type: "object", properties: { quote: { type: "object", properties: { pricing: { type: "object", properties: { lines: { type: "array", items: PriceLine }, total: Money, plus: { type: "object" } } }, coverage: { type: "object" } } } } } },
  "POST /api/v1/orders": {
    headers: [{ name: "Idempotency-Key", required: true, description: "Unique per checkout attempt; retries return the same order." }],
    request: { allOf: [QuoteRequest, { type: "object", required: ["paymentToken"], properties: { paymentToken: { type: "string" }, expectedTotal: Money, videoId: { type: "string" }, referralCode: { type: "string" }, groupCartId: { type: "string" } } }] },
    response: { type: "object", properties: { orderId: { type: "string" }, status: { type: "string" }, replayed: { type: "boolean" } } },
  },
};

export function openApiDocument(router: Router) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of router.routes) {
    const oaPath = r.path.replace(/:([a-zA-Z_]+)/g, "{$1}");
    const key = `${r.method} ${r.path}`;
    const tag = TAGS.find(([re]) => re.test(r.path))?.[1] ?? "Platform";
    const isPublic = PUBLIC.some((re) => re.test(r.path));
    const b = BODIES[key];
    const op: Record<string, unknown> = {
      tags: [tag],
      operationId: key.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, ""),
      parameters: [
        ...r.keys.map((k) => ({ name: k, in: "path", required: true, schema: { type: "string" } })),
        ...(b?.headers ?? []).map((h) => ({ name: h.name, in: "header", required: h.required, description: h.description, schema: { type: "string" } })),
      ],
      responses: {
        "200": { description: "OK", ...(b?.response ? { content: { "application/json": { schema: b.response } } } : {}) },
        "4XX": { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
      ...(isPublic ? { security: [] } : {}),
    };
    if (b?.request) op.requestBody = { required: true, content: { "application/json": { schema: b.request } } };
    (paths[oaPath] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: { title: "ABU9 (أبو9) Platform API", version: "0.1.0", description: "Modular-monolith API for customers, couriers, restaurants, logistics partners, creators and operations. Money is integer halalas. Times are UTC ISO-8601; display in Asia/Riyadh." },
    servers: [{ url: "http://localhost:8080" }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Session token from /auth/otp/verify" } },
      schemas: { Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {}, requestId: { type: "string" } } } } } },
    },
    paths,
  };
}
