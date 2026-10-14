# ABU9 operational runbooks

First-response guides for the alerts in `infra/prometheus/alerts.yml`. Every manual intervention
below goes through the admin app (`/admin`), which requires staff MFA and writes an audit-log entry
with your reason. Never fix production data with SQL: the ledger, points and audit tables are
append-only by design, and corrections are made with reversing entries.

## dispatch-backlog
**Signal:** `abu9_dispatch_oldest_unassigned_seconds > 300`. A delivery has been waiting more than 5 minutes for a courier.
1. Admin → **التوزيع (Dispatch)**. Find the unassigned jobs and read the rejected-candidate reasons (`over_capacity`, `deadline`, `too_far`, `rejected_before`).
2. If couriers are online but over capacity, assign manually (the 2-order cap still applies). Write the reason.
3. If no courier is near the branch zone, request peak capacity from the logistics partner. Today that means phoning their dispatcher, and capacity requests are made through the API (see BACKLOG).
4. If the promised deadline can no longer be met, contact the customer through support and offer cancellation per policy. Compensation is decided by the evidence-based support flow, not ad hoc.
5. If the backlog is zone-wide, set the zone to **restricted** (Admin → Zones & pricing) so new orders there are refused instead of failing late.

## no-couriers
**Signal:** active orders while no courier has been online for 3 minutes.
1. Check `GET /healthz`, then courier app reachability. A courier-app outage looks the same as no couriers.
2. Call the logistics partner's on-duty dispatcher (contact sheet lives with ops, not in the repo).
3. Pause affected zones (status **paused**) to stop new orders, and keep existing orders informed via support.

## acceptance-backlog
**Signal:** more than 10 orders waiting for restaurant acceptance. Orders auto-reject after 240 s and are not charged, because the authorisation is voided.
1. Admin → Orders filtered by `placed`. Find which restaurants are slow.
2. Call the restaurant. If its tablet is offline, pause the branch (restaurant app → Menu → pause, or ops on its behalf).
3. Ops can accept on behalf of a restaurant (Order detail → intervene → accept) **only** with the restaurant's confirmation on the phone. This is audited.

## rejections
**Signal:** more than 15 rejections in an hour.
1. Group by restaurant and reason in Admin → Orders.
2. `item_unavailable` usually means stock is not maintained, so coach the restaurant on availability toggles.
3. Timeouts usually mean an unattended tablet (see acceptance-backlog).

## api-errors
**Signal:** more than 2% of requests return 5xx, or p95 checkout latency is above 1 s.
1. Search the logs for `"level":"error"` with `request_failed` and group by `path`. Every error carries a `requestId` that is also returned to the client.
2. Check database health: connections, slow queries, disk. The pool size is `DB_POOL_MAX`.
3. If it started with a deploy, roll back the image. Migrations are forward-only, so they are written to be backward compatible with the previous release.
4. PSP errors on `/orders` → check the payment provider status page. Orders fail closed (no capture without acceptance).

## api-down
1. Check the load balancer target health and container restarts (`GET /healthz` verifies the DB too).
2. Production refuses to start when secrets or verified-TLS DB settings are missing. Check the startup log for `missing required secret` or `sslmode`.

## Staff access
- **Lost authenticator:** an admin resets the user's TOTP by clearing `totp_*` through a controlled DB change with a second approver (no UI yet, see BACKLOG). The user re-enrols at next login.
- **Leaver:** set the user's status to suspended (Admin → Partners → Customers). Their sessions stop working immediately.

## Payouts (separation of duties)
Settlement statements are approved by one finance user, and the bank payout is recorded by a **different** user. Both the API and a database constraint enforce this. Bank transfers themselves are executed in the bank portal, and the reference is recorded in ABU9.
