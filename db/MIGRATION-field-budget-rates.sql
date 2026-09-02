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
