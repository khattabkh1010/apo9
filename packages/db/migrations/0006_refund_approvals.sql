-- Four-eyes for large refunds: an agent proposes, a DIFFERENT person with refunds.issue_large
-- approves before any money moves. The threshold is a platform setting.
alter table support_tickets drop constraint support_tickets_status_check;
alter table support_tickets add constraint support_tickets_status_check
  check (status in ('open','awaiting_evidence','pending_approval','resolved','rejected'));

create table refund_approvals (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets(id),
  fault_party text not null check (fault_party in ('abu9','restaurant','logistics','customer','external')),
  amount bigint not null check (amount > 0),
  note text not null,
  proposed_by uuid not null references users(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid references users(id),
  decision_reason text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (decided_by is null or decided_by <> proposed_by)
);
create unique index refund_approvals_one_pending on refund_approvals (ticket_id) where status = 'pending';

insert into platform_settings(key, value) values ('refund_four_eyes_threshold', '10000') on conflict (key) do nothing;
