-- Field Budget — complete schema for a NEW, EMPTY database
--
-- Use this to stand up a second brand's database (the Unearthed site) in one
-- go. Paste it into the Neon SQL editor, or:
--   psql "$DATABASE_URL" -f db/init-new-database.sql
--
-- It is schema.sql (minus the Peru seed) followed by every migration in order,
-- then one fix: schema.sql still creates the original one-level trigger
-- (categories_one_level_trg), and the 3-level migration adds its replacement
-- (categories_depth) without dropping it. With both in place a leg -> category
-- -> subcategory tree is rejected with "Subcategories cannot be nested more
-- than one level deep". The last statement removes the old trigger.
--
-- Do NOT run this against the existing Pacific Discovery database.

-- ======================================================================
-- schema.sql (without the Peru seed)
-- ======================================================================

-- Field Budget — Neon (Postgres) schema
-- All money is stored as integer minor units (PEN 40.50 -> 4050).
-- Nothing derived is stored except entries.budget_amount, frozen at entry time.

create table if not exists budgets (
  id              text primary key,
  name            text not null,
  currency        char(3) not null,                    -- budget currency, e.g. 'PEN'
  base_currency   char(3) not null default 'NZD',
  default_rate    numeric(14,6) not null default 1,    -- budget currency per 1 unit of entry currency
  funded_base     bigint,                              -- approved NZD, minor units
  starts_on       date,
  ends_on         date,
  status          text not null default 'active',      -- active | closed
  drive_folder_id text,                                -- receipts folder in the Shared Drive
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists categories (
  id         text primary key,
  budget_id  text not null references budgets(id) on delete cascade,
  name       text not null,
  allocated  bigint not null default 0,                -- minor units of budget currency
  sort_order integer not null default 0,
  -- One level only, enforced by the trigger below. Allocation sits on any node;
  -- a parent's displayed total is its own plus its children's.
  parent_id  text references categories(id) on delete cascade
);
create index if not exists categories_budget_idx on categories(budget_id);
create index if not exists categories_parent_idx on categories(parent_id);

create or replace function categories_one_level() returns trigger as $$
begin
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'A category cannot be its own parent';
    end if;
    if exists (select 1 from categories where id = new.parent_id and parent_id is not null) then
      raise exception 'Subcategories cannot be nested more than one level deep';
    end if;
    if exists (select 1 from categories where parent_id = new.id) then
      raise exception 'This category has subcategories, so it cannot become one';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists categories_one_level_trg on categories;
create trigger categories_one_level_trg
  before insert or update on categories
  for each row execute function categories_one_level();

create table if not exists assignments (
  budget_id text not null references budgets(id) on delete cascade,
  email     text not null,                             -- normalised lowercase, +tags stripped
  role      text not null default 'instructor',
  added_at  timestamptz not null default now(),
  primary key (budget_id, email)
);
create index if not exists assignments_email_idx on assignments(email);

-- Append-only. Corrections are new rows referencing corrects_id; nothing is updated.
create table if not exists entries (
  id             text primary key,                     -- UUID generated on the device
  budget_id      text not null references budgets(id) on delete cascade,
  category_id    text,                                 -- null for cash movements
  email          text not null,
  entry_type     text not null,                        -- expense|withdrawal|exchange|transfer|correction
  group_id       text,                                 -- ties the two legs of an exchange
  spent_on       date not null,
  amount         bigint not null,                      -- minor units, in `currency`, as paid
  currency       char(3) not null,
  rate           numeric(14,6) not null default 1,     -- budget currency per 1 unit of `currency`
  budget_amount  bigint not null,                      -- converted at `rate`, frozen forever
  payment_method text not null default 'cash',         -- cash | card
  description    text not null default '',
  receipt_file_id text,                                -- Google Drive file id
  receipt_link   text,                                 -- Drive webViewLink, for finance
  actual_base    bigint,                               -- true NZD, filled at reconciliation
  corrects_id    text,
  created_at     timestamptz not null,                 -- device clock
  received_at    timestamptz not null default now()
);
create index if not exists entries_budget_idx on entries(budget_id, received_at);
create index if not exists entries_email_idx on entries(email);

-- Single-use magic-link tokens. Hash stored, never the token itself.
create table if not exists magic_tokens (
  token_hash text primary key,
  email      text not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists magic_tokens_expiry_idx on magic_tokens(expires_at);

-- ======================================================================
-- MIGRATION-field-budget-subcategories.sql
-- ======================================================================

-- Field Budget — subcategories
--
-- Run once against the database both the field app and budget-admin use.
-- Safe to re-run.
--
-- Model: one level of nesting. Allocation lives on leaves; a category with
-- children displays the sum of those children and holds no figure of its own.
-- Entries always point at a leaf, so nothing about existing rows changes —
-- every current category is a leaf until it gains a child.

alter table categories
  add column if not exists parent_id text references categories(id) on delete cascade;

create index if not exists categories_parent_idx on categories(parent_id);

-- A parent must itself be top level. Enforced in the API too, but this is the
-- backstop that keeps the tree exactly two deep.
create or replace function field_budget_check_category_depth() returns trigger as $$
begin
  if new.parent_id is not null then
    if exists (select 1 from categories where id = new.parent_id and parent_id is not null) then
      raise exception 'Categories nest one level only';
    end if;
    if new.parent_id = new.id then
      raise exception 'A category cannot be its own parent';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists categories_depth on categories;
create trigger categories_depth
  before insert or update on categories
  for each row execute function field_budget_check_category_depth();

-- ======================================================================
-- MIGRATION-field-budget-rates.sql
-- ======================================================================

-- Field Budget — per-currency planning rates
--
-- Run once against the database both the field app and budget-admin use.
-- Safe to re-run.
--
-- One default_rate per budget can only ever be right for one foreign currency:
-- PEN per NZD is ~2.2, PEN per USD ~3.34, PEN per EUR ~4.05. Whichever single
-- value was stored, the other two prefilled wrong on the instructor's form.
--
-- `rates` maps a currency code to its rate expressed in the BUDGET currency
-- per 1 unit of that currency, e.g. for a PEN budget:
--   {"NZD": 2.20, "USD": 3.34, "EUR": 4.05}
-- default_rate is kept as a fallback for budgets created before this.

alter table budgets
  add column if not exists rates jsonb not null default '{}'::jsonb;

-- Carry the existing single rate over as the base-currency rate so nothing
-- regresses for budgets already in flight.
update budgets
   set rates = jsonb_build_object(base_currency, default_rate)
 where rates = '{}'::jsonb
   and default_rate is not null
   and default_rate <> 1;

-- ======================================================================
-- MIGRATION-field-budget-3-levels.sql
-- ======================================================================

-- Field Budget — three category levels, currency on the top level
--
-- Run once against the database both the field app and budget-admin use.
-- Safe to re-run.
--
-- WHAT CHANGES
-- Level 1 is now a programme leg and carries the currency: one budget can hold
-- "Peru" in PEN and "Ecuador" in USD, which is what the original spreadsheet
-- actually did. Levels 2 and 3 are categories and subcategories.
--
-- Allocation still lives on leaves, recursively: a category with children is the
-- sum of its children; one without children holds its own figure. So a leg is
-- the sum of its categories, and a category is the sum of its subcategories --
-- unless it has none, in which case it holds the allocation itself.
--
-- budgets.currency is retired. It is left in place, nullable, so existing rows
-- and any old code path do not break, but nothing reads it any more.

alter table categories add column if not exists currency char(3);
alter table categories add column if not exists rates jsonb not null default '{}'::jsonb;

create index if not exists categories_currency_idx on categories(budget_id) where parent_id is null;

-- Carry each budget's currency and rates down to its top-level categories, so
-- every existing category becomes a leg denominated as before.
update categories c
   set currency = coalesce(c.currency, b.currency, b.base_currency, 'NZD'),
       rates    = case when c.rates = '{}'::jsonb then coalesce(b.rates, '{}'::jsonb) else c.rates end
  from budgets b
 where c.budget_id = b.id
   and c.parent_id is null;

alter table budgets alter column currency drop not null;

-- Depth guard: at most three levels, and currency only on level 1.
create or replace function field_budget_check_category_depth() returns trigger as $$
declare
  p1 text;
  p2 text;
begin
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'A category cannot be its own parent';
    end if;
    select parent_id into p1 from categories where id = new.parent_id;
    if p1 is not null then
      select parent_id into p2 from categories where id = p1;
      if p2 is not null then
        raise exception 'Categories nest three levels only';
      end if;
    end if;
    -- Currency and rates are properties of the leg, so they are meaningless
    -- deeper down. Normalised rather than rejected, so a careless write can't
    -- create a second source of truth.
    new.currency := null;
    new.rates := '{}'::jsonb;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists categories_depth on categories;
create trigger categories_depth
  before insert or update on categories
  for each row execute function field_budget_check_category_depth();

-- ======================================================================
-- MIGRATION-field-budget-codes.sql
-- ======================================================================

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

-- ======================================================================
-- Fix: retire the one-level trigger the 3-level migration superseded
-- ======================================================================

drop trigger if exists categories_one_level_trg on categories;
drop function if exists categories_one_level();
