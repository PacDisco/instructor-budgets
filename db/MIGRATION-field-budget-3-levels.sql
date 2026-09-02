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
