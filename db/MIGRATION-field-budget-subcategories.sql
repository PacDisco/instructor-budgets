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
