-- ABU9 foundation schema.
-- Conventions: money = bigint halalas (1 SAR = 100). Timestamps = timestamptz (UTC); display in Asia/Riyadh.
-- Every table that represents a financial fact is append-only (enforced by triggers below).

-- ═════════════════════════════ IDENTITY ═════════════════════════════
create table users (
  id uuid primary key default gen_random_uuid(),
  phone text unique,                      -- E.164 (+9665XXXXXXXX)
  email text unique,
  name text,
  locale text not null default 'ar' check (locale in ('ar','en')),
  status text not null default 'active' check (status in ('active','suspended','deleted')),
  created_at timestamptz not null default now()
);

create table user_roles (
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in (
    'customer','courier','restaurant_owner','restaurant_staff','logistics_admin','logistics_dispatcher',
    'creator','ops_agent','ops_manager','finance','admin')),
  scope_type text not null default 'global' check (scope_type in ('global','restaurant','logistics_company','zone')),
  -- sentinel all-zero uuid for global scope (primary keys cannot contain nulls)
  scope_id uuid not null default '00000000-0000-0000-0000-000000000000',
  granted_by uuid references users(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, role, scope_type, scope_id)
);

create table otp_challenges (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index otp_phone_idx on otp_challenges (phone, created_at desc);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text,
  created_at timestamptz not null default now()
);

create table addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  label text not null,
  lat double precision not null check (lat between 15 and 33),
  lng double precision not null check (lng between 34 and 56),
  district text,
  details text,
  building text,
  notes text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

-- ═════════════════════════════ COVERAGE ═════════════════════════════
create table zones (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text not null,
  status text not null default 'active' check (status in ('active','paused','restricted')),
  polygon jsonb not null,                 -- [{lat,lng},...]
  sla_minutes int not null default 45 check (sla_minutes between 15 and 120),
  created_at timestamptz not null default now()
);

create table delivery_pricing_configs (
  id uuid primary key default gen_random_uuid(),
  zone_id uuid references zones(id),      -- null = platform default
  basic_fee bigint not null check (basic_fee >= 0),
  base_distance_km numeric(5,2) not null default 2,
  additional_fee_per_increment bigint not null check (additional_fee_per_increment >= 0),
  additional_increment_km numeric(5,2) not null default 0.5 check (additional_increment_km > 0),
  additional_fee_cap bigint,
  service_fee bigint not null default 0,
  small_order_fee bigint not null default 0,
  small_order_threshold bigint not null default 0,
  vat_rate_bps int not null default 1500,
  effective_from timestamptz not null default now(),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table platform_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

-- ═════════════════════════════ RESTAURANTS ═════════════════════════════
create table restaurants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name_ar text not null,
  name_en text not null,
  description_ar text,
  cuisine_tags text[] not null default '{}',
  logo_url text,
  cover_url text,
  brand_color text,
  status text not null default 'onboarding' check (status in ('onboarding','active','suspended','churned')),
  activated_at timestamptz,
  rating_sum int not null default 0,
  rating_count int not null default 0,
  is_demo boolean not null default false,
  vat_number text,
  cr_number text,
  created_at timestamptz not null default now()
);

create table restaurant_members (
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','manager','staff')),
  primary key (restaurant_id, user_id)
);

create table branches (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name_ar text not null,
  name_en text not null,
  lat double precision not null,
  lng double precision not null,
  district text,
  phone text,
  opening_hours jsonb not null default '{}',   -- {"0":[["11:00","02:00"]], ...} Riyadh local, 0=Sunday
  accepting_orders boolean not null default true,
  prep_minutes_default int not null default 15 check (prep_minutes_default between 3 and 90),
  created_at timestamptz not null default now()
);

create table branch_zone_rules (
  branch_id uuid not null references branches(id) on delete cascade,
  zone_id uuid not null references zones(id) on delete cascade,
  enabled boolean not null default true,
  max_road_km numeric(5,2) not null,
  max_travel_minutes int not null,
  primary key (branch_id, zone_id)
);

create table restaurant_contract_terms (
  restaurant_id uuid primary key references restaurants(id) on delete cascade,
  auto_deduct_reason_codes text[] not null default '{}',
  dispute_window_hours int not null default 72,
  allow_subscription_netting boolean not null default false,
  signed_at timestamptz,
  document_url text
);

create table restaurant_subscriptions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  plan_code text not null check (plan_code in ('starter','growth','pro','enterprise')),
  custom_monthly_price bigint,
  billing_interval text not null default 'month' check (billing_interval in ('month','year')),
  status text not null check (status in ('trialing','active','past_due','cancelled')),
  trial_ends_at timestamptz,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index restaurant_one_live_sub on restaurant_subscriptions (restaurant_id) where status <> 'cancelled';

create table plan_change_proposals (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  from_plan text not null,
  to_plan text not null,
  reason text not null,
  effective_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','accepted','declined','expired')),
  notified_at timestamptz,
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table restaurant_invoices (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  subscription_id uuid not null references restaurant_subscriptions(id),
  period_start timestamptz not null,
  period_end timestamptz not null,
  plan_code text not null,
  amount bigint not null check (amount >= 0),
  vat bigint not null check (vat >= 0),
  status text not null default 'open' check (status in ('open','paid','void')),
  created_at timestamptz not null default now(),
  unique (subscription_id, period_start)
);

-- ═════════════════════════════ CATALOG ═════════════════════════════
create table menu_categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name_ar text not null,
  name_en text not null,
  sort int not null default 0
);

create table menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  category_id uuid references menu_categories(id) on delete set null,
  name_ar text not null,
  name_en text not null,
  description_ar text,
  description_en text,
  price bigint not null check (price >= 0),       -- VAT-inclusive
  image_url text,
  calories int,
  tags text[] not null default '{}',
  is_available boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index menu_items_restaurant_idx on menu_items (restaurant_id);

create table branch_item_availability (
  branch_id uuid not null references branches(id) on delete cascade,
  item_id uuid not null references menu_items(id) on delete cascade,
  is_available boolean not null default true,
  stock_qty int check (stock_qty is null or stock_qty >= 0),
  updated_at timestamptz not null default now(),
  primary key (branch_id, item_id)
);

create table modifier_groups (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references menu_items(id) on delete cascade,
  name_ar text not null,
  name_en text not null,
  min_select int not null default 0,
  max_select int not null default 1,
  sort int not null default 0,
  check (min_select >= 0 and max_select >= min_select)
);

create table modifier_options (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references modifier_groups(id) on delete cascade,
  name_ar text not null,
  name_en text not null,
  price_delta bigint not null default 0 check (price_delta >= 0),
  is_available boolean not null default true,
  sort int not null default 0
);

create table favorites (
  user_id uuid not null references users(id) on delete cascade,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, restaurant_id)
);

-- ═════════════════════════════ CONTENT & CREATORS ═════════════════════════════
create table creators (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  handle text not null unique,
  display_name text not null,
  bio text,
  status text not null default 'pending' check (status in ('pending','approved','suspended')),
  approved_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table videos (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  creator_id uuid references creators(id),
  uploaded_by uuid references users(id),
  caption_ar text,
  caption_en text,
  video_url text not null,
  poster_url text,
  duration_s int,
  status text not null default 'pending_review' check (status in ('pending_review','approved','rejected','removed')),
  moderated_by uuid references users(id),
  moderated_at timestamptz,
  rejection_reason text,
  view_count int not null default 0,
  like_count int not null default 0,
  created_at timestamptz not null default now()
);
create index videos_feed_idx on videos (status, created_at desc);

create table video_items (
  video_id uuid not null references videos(id) on delete cascade,
  item_id uuid not null references menu_items(id) on delete cascade,
  appears_at_s int not null default 0,
  primary key (video_id, item_id)
);

create table video_events (
  id bigserial primary key,
  video_id uuid not null references videos(id) on delete cascade,
  user_id uuid references users(id),
  kind text not null check (kind in ('view','like','unlike','share','add_to_cart','open_restaurant')),
  created_at timestamptz not null default now()
);
create index video_events_user_idx on video_events (user_id, created_at desc);

create table creator_campaigns (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references restaurants(id),
  name text not null,
  incentive_type text not null default 'none' check (incentive_type in ('none','fixed_per_order','percent_of_food')),
  incentive_value bigint not null default 0,    -- halalas or basis points
  funded_by text not null default 'restaurant' check (funded_by in ('abu9','restaurant','shared')),
  budget bigint not null default 0,
  spent bigint not null default 0 check (spent <= budget),
  status text not null default 'draft' check (status in ('draft','pending_approval','active','paused','ended')),
  approved_by uuid references users(id),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

create table creator_campaign_enrollments (
  campaign_id uuid not null references creator_campaigns(id) on delete cascade,
  creator_id uuid not null references creators(id) on delete cascade,
  status text not null default 'opted_in' check (status in ('invited','opted_in','approved','removed')),
  created_at timestamptz not null default now(),
  primary key (campaign_id, creator_id)
);

create table referral_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  creator_id uuid references creators(id),
  owner_user_id uuid references users(id),
  campaign_id uuid references creator_campaigns(id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ═════════════════════════════ LOGISTICS ═════════════════════════════
create table logistics_companies (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null,
  name_en text not null,
  cr_number text,
  status text not null default 'active' check (status in ('onboarding','active','suspended')),
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table logistics_contracts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references logistics_companies(id),
  per_order bigint not null,
  per_batched_order bigint not null,
  per_km_beyond bigint not null default 0,
  included_km numeric(5,2) not null default 3,
  committed_hourly_minimum bigint not null default 0,
  auto_deduct_reason_codes text[] not null default '{}',
  dispute_window_hours int not null default 72,
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_at timestamptz not null default now()
);

create table zone_capacity_commitments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references logistics_companies(id),
  zone_id uuid not null references zones(id),
  weekday int not null check (weekday between 0 and 6),
  start_hour int not null check (start_hour between 0 and 23),
  end_hour int not null check (end_hour between 1 and 24),
  committed_couriers int not null check (committed_couriers > 0)
);

create table capacity_requests (
  id uuid primary key default gen_random_uuid(),
  zone_id uuid not null references zones(id),
  company_id uuid references logistics_companies(id),
  requested_couriers int not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  status text not null default 'open' check (status in ('open','accepted','partially_accepted','declined','expired')),
  committed_couriers int,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table couriers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id),
  company_id uuid not null references logistics_companies(id),
  display_name text not null,
  vehicle_type text not null default 'car' check (vehicle_type in ('car','motorcycle','bicycle')),
  capacity_type text not null default 'committed' check (capacity_type in ('committed','on_demand')),
  status text not null default 'offline' check (status in ('offline','online','on_break','suspended')),
  last_lat double precision,
  last_lng double precision,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

-- ═════════════════════════════ PROMOTIONS & LOYALTY ═════════════════════════════
create table promotions (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  restaurant_id uuid references restaurants(id),
  title_ar text not null,
  kind text not null check (kind in ('percent','fixed')),
  value bigint not null check (value > 0),
  max_discount bigint,
  min_food_subtotal bigint not null default 0,
  abu9_share_bps int not null,
  restaurant_share_bps int not null,
  budget bigint not null check (budget >= 0),
  spent bigint not null default 0,
  per_customer_limit int not null default 1,
  first_order_only boolean not null default false,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  active boolean not null default true,
  approved_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (abu9_share_bps + restaurant_share_bps = 10000),
  check (spent <= budget)
);

create table loyalty_campaigns (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references restaurants(id),
  name text not null,
  multiplier numeric(4,2) not null check (multiplier >= 1),
  budget bigint not null check (budget >= 0),
  spent bigint not null default 0,
  abu9_share_bps int not null,
  restaurant_share_bps int not null,
  status text not null default 'draft' check (status in ('draft','active','paused','exhausted','ended')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  approved_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (abu9_share_bps + restaurant_share_bps = 10000),
  check (spent <= budget)
);

-- ═════════════════════════════ ORDERS ═════════════════════════════
create table group_carts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_user_id uuid not null references users(id),
  restaurant_id uuid not null references restaurants(id),
  branch_id uuid not null references branches(id),
  status text not null default 'open' check (status in ('open','locked','ordered','expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table group_cart_items (
  id uuid primary key default gen_random_uuid(),
  group_cart_id uuid not null references group_carts(id) on delete cascade,
  user_id uuid not null references users(id),
  item_id uuid not null references menu_items(id),
  qty int not null check (qty between 1 and 50),
  option_ids uuid[] not null default '{}',
  note text,
  created_at timestamptz not null default now()
);

create sequence order_number_seq start 100100;

create table orders (
  id uuid primary key default gen_random_uuid(),
  number bigint not null unique default nextval('order_number_seq'),
  customer_id uuid not null references users(id),
  restaurant_id uuid not null references restaurants(id),
  branch_id uuid not null references branches(id),
  zone_id uuid references zones(id),
  group_cart_id uuid references group_carts(id),
  status text not null check (status in ('pending_payment','placed','accepted','preparing','ready_for_pickup','picked_up','delivered','rejected','cancelled','delivery_failed')),
  address jsonb not null,
  dropoff_lat double precision not null,
  dropoff_lng double precision not null,
  road_distance_km numeric(6,2) not null,
  route_source text not null,
  food_subtotal bigint not null check (food_subtotal >= 0),
  food_discount bigint not null default 0,
  total bigint not null check (total >= 0),
  pricing jsonb not null,               -- full breakdown snapshot shown to customer
  plus_applied boolean not null default false,
  promo_id uuid references promotions(id),
  points_redeemed int not null default 0,
  prep_minutes int,
  ready_at timestamptz,
  promised_by timestamptz,
  eta_at timestamptz,
  placed_at timestamptz,
  accepted_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  notes text,
  video_id uuid references videos(id),
  referral_code_id uuid references referral_codes(id),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (customer_id, idempotency_key)
);
create index orders_branch_status_idx on orders (branch_id, status);
create index orders_customer_idx on orders (customer_id, created_at desc);
create index orders_status_idx on orders (status, created_at desc);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  item_id uuid not null references menu_items(id),
  added_by uuid references users(id),
  name_ar text not null,
  name_en text not null,
  qty int not null check (qty > 0),
  unit_price bigint not null,
  options jsonb not null default '[]',
  line_total bigint not null
);

create table order_events (
  id bigserial primary key,
  order_id uuid not null references orders(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_type text not null,
  actor_id uuid,
  note text,
  created_at timestamptz not null default now()
);
create index order_events_order_idx on order_events (order_id, id);

create table delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  status text not null check (status in ('unassigned','assigned','at_pickup','picked_up','at_dropoff','delivered','failed','cancelled')),
  courier_id uuid references couriers(id),
  company_id uuid references logistics_companies(id),
  batched_with_job_id uuid references delivery_jobs(id),
  pickup_code text not null,
  dropoff_code text not null,
  suggested_depart_at timestamptz,
  eta_at timestamptz,
  assigned_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  failure_reason text,
  distance_km numeric(6,2),
  compensation bigint,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);
create unique index delivery_one_active_job on delivery_jobs (order_id) where status not in ('delivered','failed','cancelled');
create index delivery_jobs_courier_idx on delivery_jobs (courier_id, status);

create table dispatch_decisions (
  id bigserial primary key,
  job_id uuid not null references delivery_jobs(id) on delete cascade,
  strategy text not null,
  decision jsonb not null,
  overridden_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table courier_job_rejections (
  job_id uuid not null references delivery_jobs(id) on delete cascade,
  courier_id uuid not null references couriers(id),
  reason text,
  created_at timestamptz not null default now(),
  primary key (job_id, courier_id)
);

create table courier_locations (
  id bigserial primary key,
  courier_id uuid not null references couriers(id),
  job_id uuid references delivery_jobs(id),
  lat double precision not null,
  lng double precision not null,
  recorded_at timestamptz not null default now()
);
create index courier_locations_idx on courier_locations (courier_id, recorded_at desc);

create table ratings (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references orders(id),
  user_id uuid not null references users(id),
  restaurant_stars int check (restaurant_stars between 1 and 5),
  courier_stars int check (courier_stars between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);

create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id),
  user_id uuid not null references users(id),
  reason_code text not null,
  fault_party text check (fault_party in ('abu9','restaurant','logistics','customer','external')),
  status text not null default 'open' check (status in ('open','awaiting_evidence','resolved','rejected')),
  description text,
  evidence jsonb not null default '[]',
  affected_amount bigint,
  resolution jsonb,
  resolved_by uuid references users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table incidents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id),
  job_id uuid references delivery_jobs(id),
  reported_by uuid references users(id),
  kind text not null,
  description text,
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  status text not null default 'open' check (status in ('open','investigating','resolved')),
  created_at timestamptz not null default now()
);

-- ═════════════════════════════ PAYMENTS ═════════════════════════════
create table payments (
  id uuid primary key default gen_random_uuid(),
  purpose text not null check (purpose in ('order','abu9_plus')),
  order_id uuid references orders(id),
  user_id uuid not null references users(id),
  provider text not null,                 -- 'mock' in development. NEVER a live provider without credentials+approvals.
  provider_ref text,
  method text,
  status text not null check (status in ('requires_action','authorized','captured','voided','failed','refunded','partially_refunded')),
  amount bigint not null check (amount >= 0),
  captured_amount bigint not null default 0,
  refunded_amount bigint not null default 0,
  idempotency_key text not null unique,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (refunded_amount <= captured_amount),
  check (captured_amount <= amount)
);

create table payment_events (
  id bigserial primary key,
  payment_id uuid references payments(id),
  provider text not null,
  provider_event_id text not null,
  type text not null,
  payload jsonb not null,
  signature_valid boolean not null,
  processed_at timestamptz,
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id),
  order_id uuid references orders(id),
  ticket_id uuid references support_tickets(id),
  amount bigint not null check (amount > 0),
  reason_code text not null,
  fault_party text not null,
  funding text not null check (funding in ('abu9','restaurant_authorized')),
  status text not null default 'pending' check (status in ('pending','succeeded','failed')),
  provider_ref text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table compensation_claims (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  refund_id uuid references refunds(id),
  party_type text not null check (party_type in ('restaurant','logistics')),
  party_id uuid not null,
  amount bigint not null check (amount > 0),
  reason_code text not null,
  status text not null default 'open' check (status in ('open','disputed','accepted','rejected','deductible','deducted','absorbed')),
  deductible_after timestamptz,
  dispute_note text,
  resolved_by uuid references users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- ═════════════════════════════ LEDGER ═════════════════════════════
create table ledger_accounts (
  code text primary key,
  type text not null check (type in ('asset','liability','revenue','expense','equity')),
  party_type text,
  party_id uuid,
  name text,
  created_at timestamptz not null default now()
);

create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,         -- idempotency: one business event, one entry
  event_type text not null,
  occurred_at timestamptz not null,
  posted_at timestamptz not null default now(),
  description text not null,
  ref_type text not null,
  ref_id text not null,
  reverses_entry_id uuid references journal_entries(id)
);
create index journal_entries_ref_idx on journal_entries (ref_type, ref_id);

create table journal_lines (
  id bigserial primary key,
  entry_id uuid not null references journal_entries(id),
  account_code text not null references ledger_accounts(code),
  debit bigint not null default 0 check (debit >= 0),
  credit bigint not null default 0 check (credit >= 0),
  memo text,
  check ((debit = 0) <> (credit = 0))
);
create index journal_lines_account_idx on journal_lines (account_code);

-- Immutability: ledger rows can never be updated or deleted.
create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'table % is append-only (% blocked)', tg_table_name, tg_op using errcode = '42501';
end $$;
create trigger journal_entries_immutable before update or delete on journal_entries for each row execute function forbid_mutation();
create trigger journal_lines_immutable before update or delete on journal_lines for each row execute function forbid_mutation();

-- Balance: every entry must balance at commit time.
create function check_entry_balanced() returns trigger language plpgsql as $$
declare d bigint; c bigint;
begin
  select coalesce(sum(debit),0), coalesce(sum(credit),0) into d, c from journal_lines where entry_id = new.entry_id;
  if d <> c then
    raise exception 'journal entry % unbalanced: debit % credit %', new.entry_id, d, c using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger journal_lines_balanced after insert on journal_lines
  deferrable initially deferred for each row execute function check_entry_balanced();

create view account_balances as
select a.code, a.type, a.party_type, a.party_id,
       coalesce(sum(l.debit),0)::bigint as debit,
       coalesce(sum(l.credit),0)::bigint as credit,
       case when a.type in ('asset','expense') then coalesce(sum(l.debit - l.credit),0)
            else coalesce(sum(l.credit - l.debit),0) end::bigint as balance
from ledger_accounts a left join journal_lines l on l.account_code = a.code
group by a.code;

-- ═════════════════════════════ ABU9+ ═════════════════════════════
create table plus_price_variants (
  id text primary key,
  experiment_key text not null,
  label text not null,
  interval text not null check (interval in ('month','year')),
  price bigint not null check (price > 0),
  weight int not null default 1,
  active boolean not null default true,
  is_test_price boolean not null default true
);

create table plus_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  price_variant_id text not null references plus_price_variants(id),
  price bigint not null,
  interval text not null,
  status text not null check (status in ('active','past_due','cancelled','expired')),
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  past_due_since timestamptz,
  created_at timestamptz not null default now()
);
create unique index plus_one_live_sub on plus_subscriptions (user_id) where status in ('active','past_due','cancelled');

create table plus_invoices (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references plus_subscriptions(id),
  period_start timestamptz not null,
  period_end timestamptz not null,
  amount bigint not null,
  vat bigint not null,
  status text not null check (status in ('open','paid','failed','refunded')),
  payment_id uuid references payments(id),
  recognized_amount bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (subscription_id, period_start)
);

create table plus_benefit_uses (
  order_id uuid primary key references orders(id),
  subscription_id uuid not null references plus_subscriptions(id),
  discount bigint not null,
  created_at timestamptz not null default now()
);

-- ═════════════════════════════ LOYALTY ═════════════════════════════
create table points_lots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  points int not null check (points > 0),
  remaining int not null check (remaining >= 0),
  expires_at timestamptz not null,
  source text not null check (source in ('order','campaign','restore','adjustment')),
  order_id uuid references orders(id),
  campaign_id uuid references loyalty_campaigns(id),
  created_at timestamptz not null default now(),
  check (remaining <= points)
);
create index points_lots_user_idx on points_lots (user_id, expires_at);

create table points_transactions (
  id bigserial primary key,
  user_id uuid not null references users(id),
  delta int not null,
  kind text not null check (kind in ('earn','campaign_earn','redeem','expire','reverse','restore','adjust')),
  order_id uuid references orders(id),
  lot_id uuid references points_lots(id),
  campaign_id uuid references loyalty_campaigns(id),
  cost bigint not null default 0,
  note text,
  created_at timestamptz not null default now()
);
create index points_tx_user_idx on points_transactions (user_id, id desc);
create trigger points_transactions_immutable before update or delete on points_transactions for each row execute function forbid_mutation();

create table promotion_redemptions (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references promotions(id),
  user_id uuid not null references users(id),
  order_id uuid not null unique references orders(id),
  discount bigint not null,
  abu9_funded bigint not null,
  restaurant_funded bigint not null,
  status text not null default 'applied' check (status in ('applied','reversed')),
  created_at timestamptz not null default now()
);

create table attributions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references orders(id),
  creator_id uuid references creators(id),
  video_id uuid references videos(id),
  referral_code_id uuid references referral_codes(id),
  model text not null default 'last_touch_7d',
  created_at timestamptz not null default now()
);

create table creator_incentives (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id),
  campaign_id uuid not null references creator_campaigns(id),
  order_id uuid not null references orders(id),
  amount bigint not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','paid')),
  fraud_flags text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (campaign_id, order_id)
);

-- ═════════════════════════════ SETTLEMENTS ═════════════════════════════
create table settlements (
  id uuid primary key default gen_random_uuid(),
  party_type text not null check (party_type in ('restaurant','logistics')),
  party_id uuid not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  gross bigint not null,
  deductions bigint not null,
  withheld_disputed bigint not null,
  net_payable bigint not null,
  order_count int not null default 0,
  statement jsonb not null,
  status text not null default 'draft' check (status in ('draft','approved','paid')),
  approved_by uuid references users(id),
  approved_at timestamptz,
  paid_at timestamptz,
  payout_ref text,
  created_at timestamptz not null default now(),
  unique (party_type, party_id, period_start)
);

-- ═════════════════════════════ PLATFORM ═════════════════════════════
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  title_ar text not null,
  body_ar text,
  title_en text,
  body_en text,
  data jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, created_at desc);

create table audit_logs (
  id bigserial primary key,
  actor_id uuid references users(id),
  actor_roles text[] not null default '{}',
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  reason text,
  ip text,
  request_id text,
  created_at timestamptz not null default now()
);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id, id desc);
create trigger audit_logs_immutable before update or delete on audit_logs for each row execute function forbid_mutation();

create table idempotency_keys (
  key text not null,
  user_id uuid not null,
  route text not null,
  status_code int not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, route, key)
);

create table fraud_flags (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id text not null,
  rule text not null,
  score int not null default 50,
  details jsonb not null default '{}',
  status text not null default 'open' check (status in ('open','confirmed','dismissed')),
  reviewed_by uuid references users(id),
  created_at timestamptz not null default now()
);
