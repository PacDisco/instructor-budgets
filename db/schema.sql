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

-- Seed: the Peru leg, as a worked example.
insert into budgets (id, name, currency, base_currency, default_rate, starts_on, ends_on)
values ('bud_peru_2026', 'Peru — Feb 2026', 'PEN', 'NZD', 3.34, '2026-02-02', '2026-03-04')
on conflict (id) do nothing;

insert into categories (id, budget_id, name, allocated, sort_order) values
  ('cat_food',      'bud_peru_2026', 'Food',        1448880, 1),
  ('cat_transport', 'bud_peru_2026', 'Transport',     14000, 2),
  ('cat_gratuity',  'bud_peru_2026', 'Gratuities',   150000, 3),
  ('cat_activity',  'bud_peru_2026', 'Activities',   192970, 4),
  ('cat_misc',      'bud_peru_2026', 'Misc',          50000, 5),
  ('cat_firstaid',  'bud_peru_2026', 'First aid',     16800, 6),
  ('cat_unexp',     'bud_peru_2026', 'Unexpected',        0, 7)
on conflict (id) do nothing;
