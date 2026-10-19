-- WooCommerce integration — run once in the Supabase SQL Editor.
-- Safe to re-run: every statement is idempotent.

-- Link a tracker product to a WooCommerce product. `woo_id` is the Woo
-- product id ("123") or, for a variation of a variable product, the parent id
-- and variation id ("123/456"). Products with no woo_id never sync.
alter table stock add column if not exists woo_id    text;
alter table stock add column if not exists image_url text;
alter table stock add column if not exists sku       text;
create unique index if not exists stock_woo_id_key on stock (woo_id) where woo_id is not null;

-- Where an order came from ('' = entered in the tracker, 'woo' = the website)
-- and the last WooCommerce status seen for it.
alter table orders add column if not exists source            text    default '' not null;
alter table orders add column if not exists woo_status        text;
alter table orders add column if not exists inventory_applied boolean default false;

-- Atomic stock adjustment. Webhooks can arrive in parallel (order.created and
-- order.updated fire within milliseconds of each other), so the read-modify-
-- write has to happen inside Postgres. Mirrors applyOrderInventoryDelta() in
-- app.js: never below zero, and back to ACTIVE once qty rises above zero.
create or replace function adjust_stock(p_id text, p_delta integer)
returns integer
language sql
as $$
  update stock
     set qty = greatest(0, coalesce(qty, 0) + p_delta),
         status = case when greatest(0, coalesce(qty, 0) + p_delta) > 0 then 'ACTIVE' else status end
   where id = p_id
  returning qty;
$$;

-- Small key/value store for integration bookkeeping (connection date, last
-- webhook received, last error) shown on the Integrations page.
create table if not exists integration_state (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
