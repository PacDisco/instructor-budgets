-- Field Budget — instructor access codes
--
-- Run once against the database both the field app and budget-admin use.
-- Safe to re-run.
--
-- Instructors sign in with their email address and a code an admin sets. The
-- code is a password, so it is stored as a PBKDF2-SHA256 hash with a per-user
-- salt — never in the clear, and not recoverable. An admin who forgets what they
-- set has to set a new one.
--
-- One code per person, not per budget: an instructor on both the Peru and the
-- Ecuador programme signs in once.

create table if not exists instructor_codes (
  email           text primary key,          -- normalised lowercase, +tags stripped
  code_hash       text not null,             -- pbkdf2$<iterations>$<salt_b64>$<hash_b64>
  code_set_at     timestamptz not null default now(),
  set_by          text,                      -- which admin set it, for the audit trail
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  last_login_at   timestamptz
);

create index if not exists instructor_codes_locked_idx on instructor_codes(locked_until)
  where locked_until is not null;
