-- Separation of duties on payouts: the person who records a bank payout must differ from the
-- person who approved the settlement statement.
alter table settlements add column paid_by uuid references users(id);
alter table settlements add constraint settlements_payout_four_eyes check (paid_by is null or approved_by is null or paid_by <> approved_by);
