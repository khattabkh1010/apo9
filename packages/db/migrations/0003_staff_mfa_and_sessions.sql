-- Staff MFA (TOTP, RFC 6238). The shared secret is stored encrypted (AES-256-GCM, key from
-- MFA_ENCRYPTION_KEY); the last accepted time-step prevents code replay.
alter table users
  add column totp_secret_enc text,
  add column totp_enabled_at timestamptz,
  add column totp_last_step bigint;

-- A session is MFA-verified once the user proves the second factor in THAT session.
alter table sessions
  add column mfa_verified_at timestamptz,
  add column transport text not null default 'bearer' check (transport in ('bearer','cookie'));
