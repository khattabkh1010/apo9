-- Stored PSP payment-method reference for ABU9+ renewals. This is the PSP's opaque token,
-- never card data (PAN/CVV never touch ABU9 systems).
alter table plus_subscriptions add column payment_token_ref text;

create index delivery_jobs_status_idx on delivery_jobs (status) where status not in ('delivered','failed','cancelled');
create index compensation_claims_party_idx on compensation_claims (party_type, party_id, status);
create index journal_entries_occurred_idx on journal_entries (occurred_at);
