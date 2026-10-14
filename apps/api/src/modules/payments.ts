import { z } from "zod";
import type { AppContext } from "../context.ts";
import { ApiError, notFound, type Router } from "../http/router.ts";
import { releaseOrderReservations, transitionOrder } from "../services/orders.ts";
import { log } from "../log.ts";

const Event = z.object({ id: z.string().min(1), type: z.enum(["payment.authorized", "payment.failed", "refund.succeeded"]), data: z.object({ providerRef: z.string() }) });

/**
 * PSP webhooks. Signature is verified over the RAW body before parsing; events are stored once
 * (unique provider_event_id) so redelivery is harmless.
 */
export function paymentRoutes(r: Router, app: AppContext) {
  r.post("/api/v1/payments/webhooks/:provider", async (ctx) => {
    if (ctx.params.provider !== app.payments.name) throw notFound("provider");
    const raw = await ctx.rawBody();
    const valid = app.payments.verifyWebhook(raw, ctx.req.headers["x-signature"] as string | undefined);
    if (!valid) {
      log.warn("webhook.invalid_signature", { provider: ctx.params.provider, ip: ctx.ip });
      throw new ApiError(401, "invalid_signature");
    }
    const ev = Event.parse(JSON.parse(raw.toString("utf8")));
    const pay = (await app.db.query<{ id: string; order_id: string | null; status: string }>("select id, order_id, status from payments where provider_ref = $1", [ev.data.providerRef])).rows[0];
    const ins = await app.db.query("insert into payment_events(payment_id, provider, provider_event_id, type, payload, signature_valid) values ($1,$2,$3,$4,$5,true) on conflict do nothing returning id", [pay?.id ?? null, ctx.params.provider, ev.id, ev.type, ev]);
    if (!ins.rowCount) return { ok: true, duplicate: true };
    if (!pay) return { ok: true, unmatched: true };

    if (ev.type === "payment.authorized" && pay.status === "requires_action" && pay.order_id) {
      // Completes a 3-D Secure / wallet challenge that finished asynchronously.
      await app.db.tx(async (q) => {
        await q.query("update payments set status = 'authorized', updated_at = now() where id = $1", [pay.id]);
        await transitionOrder(app, q, pay.order_id!, "placed", "system", null, "payment authorized (webhook)");
        await q.query("update orders set placed_at = now() where id = $1", [pay.order_id]);
      });
    }
    if (ev.type === "payment.failed" && pay.status === "requires_action" && pay.order_id) {
      await app.db.tx(async (q) => {
        await q.query("update payments set status = 'failed', updated_at = now() where id = $1", [pay.id]);
        await releaseOrderReservations(q, pay.order_id!);
        await transitionOrder(app, q, pay.order_id!, "cancelled", "system", null, "payment_failed (webhook)");
      });
    }
    await app.db.query("update payment_events set processed_at = now() where provider = $1 and provider_event_id = $2", [ctx.params.provider, ev.id]);
    return { ok: true };
  });
}
