-- Who proposed a creator campaign. Approval must come from a different person (four-eyes).
alter table creator_campaigns
  add column created_by uuid references users(id),
  add column description_ar text;
