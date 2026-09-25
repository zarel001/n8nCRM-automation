-- Mash & Sip CRM: data layer for the n8n WhatsApp agent.
--
-- Design rules
--   * Every state change is one SECURITY DEFINER function taking a single jsonb argument and
--     returning jsonb. n8n calls `select crm.fn($1::jsonb)` and never touches tables directly;
--     the n8n database role (see db/roles.sql) can only EXECUTE these functions.
--   * search_path is pinned to '' in every function, so every object is schema-qualified.
--   * Prices and totals are computed here from the cached storefront catalog, never by the AI.
--   * Customer lookups are always bound to the sender's customer_id, never to an order code the
--     sender typed, so one customer can't read or change another customer's order.

begin;

create schema if not exists crm;
revoke all on schema crm from public;
-- Functions are executable by PUBLIC by default; make new ones private unless granted in roles.sql.
alter default privileges in schema crm revoke execute on functions from public;

-- ─── settings ─────────────────────────────────────────────────────────────────────────────────
-- Non-secret configuration. Secrets (tokens, API keys) live in n8n credentials.

create table if not exists crm.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function crm.get_settings(p jsonb default '{}'::jsonb)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb) from crm.settings s
$$;

create or replace function crm.put_setting(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(p->>'key', '') = '' or p->'value' is null then
    raise exception 'key and value are required' using errcode = '22023';
  end if;
  insert into crm.settings (key, value) values (p->>'key', p->'value')
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('ok', true, 'key', p->>'key');
end $$;

create or replace function crm.digits(p text)
returns text
language sql immutable set search_path = ''
as $$ select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '') $$;

-- The storefront's /api/catalog response, cached so orders keep working if the site is down.
-- The only setting the bot role may write, and only with a sane shape.
create or replace function crm.cache_catalog(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if jsonb_typeof(p->'variants') is distinct from 'array' or jsonb_array_length(p->'variants') = 0
     or jsonb_typeof(p->'sizes') is distinct from 'array' or jsonb_array_length(p->'sizes') = 0
     or exists (select 1 from jsonb_array_elements(p->'variants') v where coalesce(v->>'name', '') = '')
     or exists (select 1 from jsonb_array_elements(p->'sizes') s
                 where coalesce(s->>'label', '') = '' or coalesce(s->>'price', '') !~ '^\d+(\.\d+)?$'
                    or (s->>'price')::numeric <= 0) then
    return jsonb_build_object('ok', false, 'error', 'invalid_catalog');
  end if;
  insert into crm.settings (key, value) values ('catalog', p || jsonb_build_object('cachedAt', now()))
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- Lists settings that still need real values (checked by the housekeeping workflow).
create or replace function crm.config_problems(p jsonb default '{}'::jsonb)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with s as (select crm.get_settings() as v)
  select coalesce(jsonb_agg(problem), '[]'::jsonb) from (
    select 'owner.wa_id must be the owner''s personal number, digits with country code' as problem
      from s where coalesce(s.v #>> '{owner,wa_id}', '') !~ '^\d{9,15}$'
    union all
    select 'momo.number and momo.name are required for payment instructions'
      from s where coalesce(s.v #>> '{momo,number}', '') = '' or coalesce(s.v #>> '{momo,name}', '') = ''
    union all
    select 'whatsapp.phone_number_id is not set'
      from s where coalesce(s.v #>> '{whatsapp,phone_number_id}', '') !~ '^\d+$'
    union all
    select 'catalog has not been cached yet'
      from s where s.v->'catalog' is null
  ) problems
$$;

-- ─── customers ────────────────────────────────────────────────────────────────────────────────
-- One row per WhatsApp user. `wa_id` is the phone-based ID; `bsuid` is Meta's business-scoped user
-- ID (webhooks carry it since 2026 and it is the only ID for users who hide their number behind a
-- username). Either may be missing, never both.

create table if not exists crm.customers (
  id               bigint generated always as identity primary key,
  wa_id            text unique,
  bsuid            text unique,
  username         text,
  profile_name     text,
  display_name     text,
  is_owner         boolean not null default false,
  bot_paused_until timestamptz,
  opted_out_at     timestamptz,
  last_inbound_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint customers_identity check (wa_id is not null or bsuid is not null)
);

create or replace function crm.upsert_customer(p_phone text, p_bsuid text, p_profile_name text, p_username text)
returns crm.customers
language plpgsql security definer set search_path = ''
as $$
declare
  c crm.customers;
  v_phone text := crm.digits(p_phone);
  v_bsuid text := nullif(btrim(coalesce(p_bsuid, '')), '');
  v_settings jsonb := crm.get_settings();
  v_owner_phone text := crm.digits(v_settings #>> '{owner,wa_id}');
  v_owner_bsuid text := nullif(v_settings #>> '{owner,bsuid}', '');
  v_is_owner boolean;
begin
  if v_phone is null and v_bsuid is null then
    raise exception 'customer identity missing' using errcode = '22023';
  end if;
  v_is_owner := coalesce(v_phone = v_owner_phone, false) or coalesce(v_bsuid = v_owner_bsuid, false);

  select * into c from crm.customers
   where (v_bsuid is not null and bsuid = v_bsuid) or (v_phone is not null and wa_id = v_phone)
   order by (bsuid is not distinct from v_bsuid) desc, id
   limit 1
   for update;

  if not found then
    insert into crm.customers (wa_id, bsuid, profile_name, username, is_owner, last_inbound_at)
    values (v_phone, v_bsuid, nullif(p_profile_name, ''), nullif(p_username, ''), v_is_owner, now())
    on conflict do nothing
    returning * into c;
    if found then
      return c;
    end if;
    -- a concurrent execution inserted the same person first; use that row
    select * into c from crm.customers
     where (v_bsuid is not null and bsuid = v_bsuid) or (v_phone is not null and wa_id = v_phone)
     limit 1
     for update;
  end if;

  update crm.customers u set
    wa_id = coalesce(u.wa_id, case when v_phone is not null and not exists (
              select 1 from crm.customers o where o.wa_id = v_phone and o.id <> u.id) then v_phone end),
    bsuid = coalesce(u.bsuid, case when v_bsuid is not null and not exists (
              select 1 from crm.customers o where o.bsuid = v_bsuid and o.id <> u.id) then v_bsuid end),
    profile_name = coalesce(nullif(p_profile_name, ''), u.profile_name),
    username = coalesce(nullif(p_username, ''), u.username),
    is_owner = u.is_owner or v_is_owner,
    last_inbound_at = now(),
    updated_at = now()
  where u.id = c.id
  returning * into c;
  return c;
end $$;

create or replace function crm.customer_json(c crm.customers)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id,
    'wa_id', c.wa_id,
    'bsuid', c.bsuid,
    'name', coalesce(c.display_name, c.profile_name),
    'display_name', c.display_name,
    'profile_name', c.profile_name,
    'is_owner', c.is_owner,
    'opted_out', c.opted_out_at is not null,
    'bot_paused', c.bot_paused_until is not null and c.bot_paused_until > now(),
    'last_inbound_at', c.last_inbound_at,
    -- WhatsApp only allows free-form replies inside 24 h of the customer's last message
    'window_open', c.last_inbound_at is not null and c.last_inbound_at > now() - interval '23 hours 50 minutes'
  )
$$;

create or replace function crm.get_customer(p jsonb)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  c crm.customers;
begin
  if p ? 'customer_id' then
    select * into c from crm.customers where id = (p->>'customer_id')::bigint;
  elsif p ? 'wa_id' then
    select * into c from crm.customers where wa_id = crm.digits(p->>'wa_id');
  end if;
  if c.id is null then
    return null;
  end if;
  return crm.customer_json(c);
end $$;

-- The owner's own customer row (created on the owner's first message, or here from settings).
create or replace function crm.get_owner(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  c crm.customers;
  v_phone text := crm.digits(crm.get_settings() #>> '{owner,wa_id}');
begin
  select * into c from crm.customers where is_owner order by last_inbound_at desc nulls last limit 1;
  if c.id is null and v_phone is not null then
    insert into crm.customers (wa_id, is_owner) values (v_phone, true)
    on conflict (wa_id) do update set is_owner = true
    returning * into c;
  end if;
  if c.id is null then
    return null;
  end if;
  return crm.customer_json(c);
end $$;

create or replace function crm.set_opt_out(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  c crm.customers;
begin
  update crm.customers
     set opted_out_at = case when (p->>'opted_out')::boolean then now() else null end,
         updated_at = now()
   where id = (p->>'customer_id')::bigint
  returning * into c;
  return crm.customer_json(c);
end $$;

-- ─── messages ─────────────────────────────────────────────────────────────────────────────────
-- Conversation log (both directions). The unique index on inbound message IDs is also the
-- de-duplication guard: Meta re-delivers webhooks, and a repeat insert is a no-op.

create table if not exists crm.messages (
  id            bigint generated always as identity primary key,
  customer_id   bigint not null references crm.customers(id) on delete cascade,
  direction     text not null check (direction in ('in', 'out')),
  wa_message_id text,
  type          text not null,
  body          text,
  payload       jsonb,
  status        text,
  error         jsonb,
  created_at    timestamptz not null default now()
);
create unique index if not exists messages_inbound_wamid on crm.messages (wa_message_id) where direction = 'in';
create index if not exists messages_outbound_wamid on crm.messages (wa_message_id) where direction = 'out';
create index if not exists messages_customer_recent on crm.messages (customer_id, id desc);

create or replace function crm.log_outbound(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into crm.messages (customer_id, direction, wa_message_id, type, body, payload, status, error)
  values ((p->>'customer_id')::bigint, 'out', nullif(p->>'wa_message_id', ''), coalesce(p->>'type', 'text'),
          left(p->>'body', 4096), p->'payload',
          case when p->'error' is not null and p->'error' <> 'null'::jsonb then 'failed' else 'accepted' end,
          nullif(p->'error', 'null'::jsonb))
  returning id into v_id;
  if p->'error' is not null and p->'error' <> 'null'::jsonb then
    insert into crm.ops_events (level, source, message, details)
    values ('error', 'whatsapp.send', 'WhatsApp rejected an outbound message',
            jsonb_build_object('message_id', v_id, 'customer_id', p->'customer_id', 'error', p->'error'));
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function crm.apply_status(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_customer bigint;
begin
  update crm.messages
     set status = p->>'status',
         error = coalesce(nullif(p->'errors', 'null'::jsonb), error)
   where direction = 'out' and wa_message_id = p->>'wa_message_id'
  returning customer_id into v_customer;

  if p->>'status' = 'failed' then
    insert into crm.ops_events (level, source, message, details)
    values ('warn', 'whatsapp.status', 'Outbound message failed', p);
  end if;
  return jsonb_build_object('ok', true, 'matched', v_customer is not null, 'customer_id', v_customer);
end $$;

-- Last N messages for the AI agent's context, oldest first.
create or replace function crm.recent_transcript(p jsonb)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('dir', m.direction, 'type', m.type, 'body', m.body, 'at', m.created_at)
                            order by m.id), '[]'::jsonb)
    from (select * from crm.messages
           where customer_id = (p->>'customer_id')::bigint
             and (not (p ? 'before_id') or id < (p->>'before_id')::bigint)
           order by id desc
           limit coalesce((p->>'limit')::int, 12)) m
$$;

-- Inbound texts this customer sent since the bot last replied (used to answer a burst of short
-- messages once, instead of once per message).
create or replace function crm.pending_inbound(p jsonb)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_customer bigint := (p->>'customer_id')::bigint;
  v_latest bigint;
  v_last_out bigint;
  v_first bigint;
  v_texts jsonb;
begin
  select max(id) into v_latest from crm.messages where customer_id = v_customer and direction = 'in';
  select max(id) into v_last_out from crm.messages where customer_id = v_customer and direction = 'out';
  select coalesce(jsonb_agg(m.body order by m.id), '[]'::jsonb), min(m.id) into v_texts, v_first
    from crm.messages m
   where m.customer_id = v_customer and m.direction = 'in' and m.type = 'text'
     and m.id > coalesce(v_last_out, 0) and m.id <= (p->>'message_id')::bigint;
  return jsonb_build_object(
    'is_latest', v_latest = (p->>'message_id')::bigint,
    'texts', v_texts,
    -- transcript context should end just before the pending burst
    'first_id', coalesce(v_first, (p->>'message_id')::bigint)
  );
end $$;

-- ─── catalog & orders ─────────────────────────────────────────────────────────────────────────

create or replace function crm.catalog()
returns jsonb
language sql stable set search_path = ''
as $$ select s.value from crm.settings s where s.key = 'catalog' $$;

create table if not exists crm.orders (
  id                bigint generated always as identity primary key,
  code              text not null unique,
  customer_id       bigint not null references crm.customers(id) on delete cascade,
  customer_name     text,
  items             jsonb not null,
  total             numeric(12,2) not null check (total >= 0),
  currency          text not null default 'GHS',
  status            text not null default 'awaiting_payment' check (status in (
                      'awaiting_payment', 'payment_review', 'paid', 'ready',
                      'out_for_delivery', 'delivered', 'cancelled', 'expired')),
  source            text not null default 'storefront' check (source in ('storefront', 'chat')),
  delivery_location jsonb,
  delivery_note     text,
  reminder_sent_at  timestamptz,
  paid_at           timestamptz,
  delivered_at      timestamptz,
  cancelled_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists orders_customer_recent on crm.orders (customer_id, created_at desc);
create index if not exists orders_status_age on crm.orders (status, created_at);

create or replace function crm.order_json(o crm.orders)
returns jsonb
language sql stable set search_path = ''
as $$
  select case when o.id is null then null else jsonb_build_object(
    'id', o.id,
    'code', o.code,
    'customer_id', o.customer_id,
    'customer_name', o.customer_name,
    'items', o.items,
    'total', o.total,
    'currency', o.currency,
    'status', o.status,
    'source', o.source,
    'delivery_location', o.delivery_location,
    'delivery_note', o.delivery_note,
    'paid_at', o.paid_at,
    'created_at', o.created_at
  ) end
$$;

-- Unambiguous 4-character code (no 0/O, 1/I/L): MS-7K4Q. Not a secret — lookups are bound to the
-- sender — just short enough to type as a MoMo reference.
create or replace function crm.new_order_code()
returns text
language plpgsql volatile set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text := 'MS-';
begin
  for i in 1..4 loop
    v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return v_code;
end $$;

-- p: {customer_id, variant, size, qty, name?, source?}
create or replace function crm.create_order(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_catalog jsonb := crm.catalog();
  v_customer bigint := (p->>'customer_id')::bigint;
  v_name text := nullif(btrim(coalesce(p->>'name', '')), '');
  v_variant text;
  v_size text;
  v_price numeric;
  v_qty int;
  v_max int;
  v_items jsonb;
  v_order crm.orders;
begin
  if v_catalog is null then
    return jsonb_build_object('ok', false, 'error', 'catalog_unavailable');
  end if;

  select v->>'name' into v_variant
    from jsonb_array_elements(v_catalog->'variants') v
   where lower(btrim(v->>'name')) = lower(btrim(coalesce(p->>'variant', '')))
   limit 1;
  if v_variant is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_variant',
      'options', (select jsonb_agg(v->>'name') from jsonb_array_elements(v_catalog->'variants') v));
  end if;

  select s->>'label', (s->>'price')::numeric into v_size, v_price
    from jsonb_array_elements(v_catalog->'sizes') s
   where lower(replace(s->>'label', ' ', '')) = lower(replace(coalesce(p->>'size', ''), ' ', ''))
   limit 1;
  if v_size is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_size',
      'options', (select jsonb_agg(s->>'label') from jsonb_array_elements(v_catalog->'sizes') s));
  end if;

  v_max := coalesce((v_catalog->>'maxQty')::int, 24);
  v_qty := case when (p->>'qty') ~ '^\d{1,4}$' then (p->>'qty')::int end;
  if v_qty is null or v_qty < 1 or v_qty > v_max then
    return jsonb_build_object('ok', false, 'error', 'bad_qty', 'max', v_max);
  end if;

  v_items := jsonb_build_array(jsonb_build_object('variant', v_variant, 'size', v_size, 'qty', v_qty, 'unit_price', v_price));

  -- Same order sent twice (double tap, or the customer re-sent the checkout message): reuse it.
  select * into v_order from crm.orders
   where customer_id = v_customer and status = 'awaiting_payment' and items = v_items
     and created_at > now() - interval '30 minutes'
   order by created_at desc
   limit 1;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'order', crm.order_json(v_order));
  end if;

  for attempt in 1..5 loop
    begin
      insert into crm.orders (code, customer_id, customer_name, items, total, currency, source)
      values (crm.new_order_code(), v_customer, v_name, v_items, v_price * v_qty,
              coalesce(v_catalog #>> '{brand,currency}', 'GHS'), coalesce(p->>'source', 'storefront'))
      returning * into v_order;
      exit;
    exception when unique_violation then
      if attempt = 5 then
        raise;
      end if;
    end;
  end loop;

  if v_name is not null then
    update crm.customers set display_name = v_name, updated_at = now() where id = v_customer;
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false, 'order', crm.order_json(v_order));
end $$;

-- The customer's own recent orders (agent tool). p: {customer_id, limit?}
create or replace function crm.customer_orders(p jsonb)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(crm.order_json(o) order by o.created_at desc), '[]'::jsonb)
    from (select * from crm.orders
           where customer_id = (p->>'customer_id')::bigint
           order by created_at desc
           limit coalesce((p->>'limit')::int, 5)) o
$$;

-- p: {customer_id, order_id? | code?} — cancels the customer's own unpaid order (latest, or the
-- one named). Always scoped to customer_id, so a code or ID belonging to someone else matches nothing.
create or replace function crm.cancel_order(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_order crm.orders;
begin
  update crm.orders o
     set status = 'cancelled', cancelled_at = now(), updated_at = now()
   where o.id = (
     select id from crm.orders
      where customer_id = (p->>'customer_id')::bigint
        and status in ('awaiting_payment', 'payment_review')
        and (coalesce(p->>'code', '') = '' or code = upper(btrim(p->>'code')))
        and (coalesce(p->>'order_id', '') = '' or id = (p->>'order_id')::bigint)
      order by created_at desc
      limit 1)
  returning * into v_order;
  if v_order.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_cancellable_order');
  end if;
  update crm.payments set status = 'superseded' where order_id = v_order.id and status = 'pending_owner';
  return jsonb_build_object('ok', true, 'order', crm.order_json(v_order));
end $$;

-- Delivery pin after payment. p: {customer_id, location: {latitude, longitude, name?, address?}}
create or replace function crm.set_order_location(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_order crm.orders;
begin
  update crm.orders o
     set delivery_location = p->'location', status = 'ready', updated_at = now()
   where o.id = (
     select id from crm.orders
      where customer_id = (p->>'customer_id')::bigint and status = 'paid'
      order by paid_at desc nulls last
      limit 1)
  returning * into v_order;
  if v_order.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_order_awaiting_location');
  end if;
  return jsonb_build_object('ok', true, 'order', crm.order_json(v_order));
end $$;

-- Written address / landmark from chat (agent tool). p: {customer_id, note}
create or replace function crm.set_delivery_note(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_order crm.orders;
  v_note text := left(btrim(coalesce(p->>'note', '')), 500);
begin
  if v_note = '' then
    return jsonb_build_object('ok', false, 'error', 'empty_note');
  end if;
  update crm.orders o
     set delivery_note = v_note,
         status = case when o.status = 'paid' then 'ready' else o.status end,
         updated_at = now()
   where o.id = (
     select id from crm.orders
      where customer_id = (p->>'customer_id')::bigint and status in ('paid', 'ready')
      order by paid_at desc nulls last
      limit 1)
  returning * into v_order;
  if v_order.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_paid_order');
  end if;
  return jsonb_build_object('ok', true, 'order', crm.order_json(v_order));
end $$;

-- Owner moves a delivery along. p: {order_id, status: out_for_delivery|delivered}
create or replace function crm.advance_order(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_order crm.orders;
  v_to text := p->>'status';
begin
  if v_to not in ('out_for_delivery', 'delivered') then
    return jsonb_build_object('ok', false, 'error', 'bad_status');
  end if;
  update crm.orders o
     set status = v_to,
         delivered_at = case when v_to = 'delivered' then now() else o.delivered_at end,
         updated_at = now()
   where o.id = (p->>'order_id')::bigint
     and ((v_to = 'out_for_delivery' and o.status in ('paid', 'ready'))
       or (v_to = 'delivered' and o.status in ('paid', 'ready', 'out_for_delivery')))
  returning * into v_order;
  if v_order.id is null then
    select * into v_order from crm.orders where id = (p->>'order_id')::bigint;
    return jsonb_build_object('ok', false, 'error', 'bad_transition', 'order', crm.order_json(v_order));
  end if;
  return jsonb_build_object('ok', true, 'order', crm.order_json(v_order),
    'customer', (select crm.customer_json(c) from crm.customers c where c.id = v_order.customer_id));
end $$;

-- ─── payments ─────────────────────────────────────────────────────────────────────────────────
-- A screenshot is evidence, not proof: every payment waits for the owner's decision.

create table if not exists crm.payments (
  id           bigint generated always as identity primary key,
  order_id     bigint not null references crm.orders(id) on delete cascade,
  customer_id  bigint not null references crm.customers(id) on delete cascade,
  wa_media_id  text not null,
  media_sha256 text,
  mime_type    text,
  image        bytea,
  extraction   jsonb,
  precheck     jsonb,
  verdict      text check (verdict in ('looks_ok', 'mismatch', 'unreadable')),
  txn_id       text,
  amount       numeric(12,2),
  status       text not null default 'pending_owner'
                 check (status in ('pending_owner', 'approved', 'rejected', 'superseded')),
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists payments_txn on crm.payments (txn_id) where txn_id is not null;
create index if not exists payments_sha on crm.payments (media_sha256) where media_sha256 is not null;
create index if not exists payments_order on crm.payments (order_id, created_at desc);

-- Has this transaction ID or this exact image already been used for a different order?
-- p: {order_id, txn_id?, media_sha256?}
create or replace function crm.payment_duplicates(p jsonb)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'txn_used_by', (
      select o.code from crm.payments x join crm.orders o on o.id = x.order_id
       where coalesce(p->>'txn_id', '') <> '' and x.txn_id = p->>'txn_id'
         and x.order_id <> (p->>'order_id')::bigint and x.status in ('pending_owner', 'approved')
       order by x.created_at desc limit 1),
    'image_used_by', (
      select o.code from crm.payments x join crm.orders o on o.id = x.order_id
       where coalesce(p->>'media_sha256', '') <> '' and x.media_sha256 = p->>'media_sha256'
         and x.order_id <> (p->>'order_id')::bigint
       order by x.created_at desc limit 1)
  )
$$;

-- p: {order_id, customer_id, media_id, media_sha256?, mime_type?, image_base64?, extraction?,
--     precheck?, verdict, txn_id?, amount?}
create or replace function crm.record_payment(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_order crm.orders;
  v_payment_id bigint;
begin
  select * into v_order from crm.orders
   where id = (p->>'order_id')::bigint and customer_id = (p->>'customer_id')::bigint
   for update;
  if v_order.id is null or v_order.status not in ('awaiting_payment', 'payment_review') then
    return jsonb_build_object('ok', false, 'error', 'order_not_awaiting_payment', 'order', crm.order_json(v_order));
  end if;

  update crm.payments set status = 'superseded' where order_id = v_order.id and status = 'pending_owner';

  insert into crm.payments (order_id, customer_id, wa_media_id, media_sha256, mime_type, image,
                            extraction, precheck, verdict, txn_id, amount)
  values (v_order.id, v_order.customer_id, p->>'media_id', nullif(p->>'media_sha256', ''), nullif(p->>'mime_type', ''),
          case when coalesce(p->>'image_base64', '') <> '' then decode(p->>'image_base64', 'base64') end,
          nullif(p->'extraction', 'null'::jsonb), nullif(p->'precheck', 'null'::jsonb), p->>'verdict',
          nullif(p->>'txn_id', ''),
          case when (p->>'amount') ~ '^\d+(\.\d+)?$' then (p->>'amount')::numeric end)
  returning id into v_payment_id;

  update crm.orders set status = 'payment_review', updated_at = now() where id = v_order.id
  returning * into v_order;

  return jsonb_build_object('ok', true, 'payment_id', v_payment_id, 'order', crm.order_json(v_order));
end $$;

-- Owner's decision. p: {payment_id, decision: approve|reject}
create or replace function crm.decide_payment(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_payment crm.payments;
  v_order crm.orders;
  v_other text;
begin
  select * into v_payment from crm.payments where id = (p->>'payment_id')::bigint for update;
  if v_payment.id is null then
    return jsonb_build_object('ok', false, 'error', 'payment_not_found');
  end if;
  select * into v_order from crm.orders where id = v_payment.order_id for update;

  if v_payment.status <> 'pending_owner' then
    return jsonb_build_object('ok', false, 'error', 'already_decided', 'status', v_payment.status,
                              'order', crm.order_json(v_order));
  end if;

  if p->>'decision' = 'approve' then
    if v_order.status <> 'payment_review' then
      return jsonb_build_object('ok', false, 'error', 'order_not_in_review', 'order', crm.order_json(v_order));
    end if;
    select o.code into v_other from crm.payments x join crm.orders o on o.id = x.order_id
     where v_payment.txn_id is not null and x.txn_id = v_payment.txn_id
       and x.status = 'approved' and x.id <> v_payment.id
     limit 1;
    if v_other is not null then
      return jsonb_build_object('ok', false, 'error', 'txn_already_used', 'other_order', v_other,
                                'order', crm.order_json(v_order));
    end if;
    update crm.payments set status = 'approved', decided_at = now() where id = v_payment.id;
    update crm.orders set status = 'paid', paid_at = now(), updated_at = now() where id = v_order.id
    returning * into v_order;
  elsif p->>'decision' = 'reject' then
    update crm.payments set status = 'rejected', decided_at = now() where id = v_payment.id;
    update crm.orders set status = 'awaiting_payment', updated_at = now()
     where id = v_order.id and status = 'payment_review'
    returning * into v_order;
    if v_order.id is null then
      select * into v_order from crm.orders where id = v_payment.order_id;
    end if;
  else
    return jsonb_build_object('ok', false, 'error', 'bad_decision');
  end if;

  return jsonb_build_object('ok', true, 'decision', p->>'decision', 'payment_id', v_payment.id,
    'order', crm.order_json(v_order),
    'customer', (select crm.customer_json(c) from crm.customers c where c.id = v_order.customer_id));
end $$;

-- ─── leads ────────────────────────────────────────────────────────────────────────────────────

create table if not exists crm.leads (
  id                bigint generated always as identity primary key,
  customer_id       bigint not null references crm.customers(id) on delete cascade,
  kind              text not null default 'bulk_order',
  contact_name      text,
  event_type        text,
  event_date        text,
  quantity_estimate int,
  area              text,
  flavours          text,
  notes             text,
  status            text not null default 'new' check (status in ('new', 'contacted', 'won', 'lost')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists leads_status on crm.leads (status, created_at desc);

-- p: {customer_id, contact_name?, event_type?, event_date?, quantity_estimate?, area?, flavours?, notes?}
create or replace function crm.save_lead(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into crm.leads (customer_id, contact_name, event_type, event_date, quantity_estimate, area, flavours, notes)
  values ((p->>'customer_id')::bigint, left(p->>'contact_name', 80), left(p->>'event_type', 80),
          left(p->>'event_date', 80),
          case when (p->>'quantity_estimate') ~ '^\d{1,6}$' then (p->>'quantity_estimate')::int end,
          left(p->>'area', 120), left(p->>'flavours', 200), left(p->>'notes', 1000))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'lead_id', v_id);
end $$;

-- ─── escalations & human takeover ─────────────────────────────────────────────────────────────

create table if not exists crm.escalations (
  id          bigint generated always as identity primary key,
  customer_id bigint not null references crm.customers(id) on delete cascade,
  kind        text not null check (kind in ('human_request', 'bulk_lead', 'complaint', 'system')),
  reason      text,
  summary     text,
  status      text not null default 'open' check (status in ('open', 'taken_over', 'dismissed', 'closed')),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);
create index if not exists escalations_open on crm.escalations (customer_id, status, created_at desc);

-- p: {customer_id, kind, reason?, summary?}. An identical open escalation from the last 2 hours is
-- reused, so a customer repeating "human" doesn't spam the owner.
create or replace function crm.open_escalation(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_esc crm.escalations;
begin
  select * into v_esc from crm.escalations
   where customer_id = (p->>'customer_id')::bigint and kind = p->>'kind' and status in ('open', 'taken_over')
     and created_at > now() - interval '2 hours'
   order by created_at desc limit 1;
  if found then
    return jsonb_build_object('ok', true, 'existing', true, 'escalation_id', v_esc.id, 'status', v_esc.status);
  end if;
  insert into crm.escalations (customer_id, kind, reason, summary)
  values ((p->>'customer_id')::bigint, p->>'kind', left(p->>'reason', 300), left(p->>'summary', 1000))
  returning * into v_esc;
  return jsonb_build_object('ok', true, 'existing', false, 'escalation_id', v_esc.id, 'status', v_esc.status);
end $$;

create or replace function crm.dismiss_escalation(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  update crm.escalations set status = 'dismissed', closed_at = now()
   where id = (p->>'escalation_id')::bigint and status = 'open';
  return jsonb_build_object('ok', true);
end $$;

-- Single row: which customer the owner is currently chatting with through the bot.
create table if not exists crm.owner_session (
  id                 int primary key default 1 check (id = 1),
  target_customer_id bigint references crm.customers(id) on delete set null,
  expires_at         timestamptz,
  updated_at         timestamptz not null default now()
);
insert into crm.owner_session (id) values (1) on conflict do nothing;

-- p: {customer_id? | escalation_id?, minutes?}
create or replace function crm.start_takeover(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_target bigint := (p->>'customer_id')::bigint;
  v_minutes int := coalesce((p->>'minutes')::int, 30);
  v_previous bigint;
  v_customer crm.customers;
begin
  if v_target is null and p ? 'escalation_id' then
    select customer_id into v_target from crm.escalations where id = (p->>'escalation_id')::bigint;
  end if;
  if v_target is null then
    return jsonb_build_object('ok', false, 'error', 'no_target');
  end if;

  select target_customer_id into v_previous from crm.owner_session where id = 1 for update;
  if v_previous is not null and v_previous <> v_target then
    update crm.customers set bot_paused_until = null where id = v_previous;
  end if;

  update crm.owner_session
     set target_customer_id = v_target, expires_at = now() + make_interval(mins => v_minutes), updated_at = now()
   where id = 1;
  update crm.customers set bot_paused_until = now() + make_interval(mins => v_minutes), updated_at = now()
   where id = v_target
  returning * into v_customer;
  update crm.escalations set status = 'taken_over' where customer_id = v_target and status = 'open';

  return jsonb_build_object('ok', true, 'customer', crm.customer_json(v_customer), 'previous_customer_id', v_previous);
end $$;

-- Keeps an active takeover alive while either side is talking. p: {minutes?}
create or replace function crm.touch_takeover(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_minutes int := coalesce((p->>'minutes')::int, 30);
  v_target bigint;
begin
  update crm.owner_session
     set expires_at = now() + make_interval(mins => v_minutes), updated_at = now()
   where id = 1 and target_customer_id is not null and expires_at > now()
  returning target_customer_id into v_target;
  if v_target is not null then
    update crm.customers set bot_paused_until = now() + make_interval(mins => v_minutes) where id = v_target;
  end if;
  return jsonb_build_object('ok', v_target is not null, 'customer_id', v_target);
end $$;

create or replace function crm.end_takeover(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_target bigint;
  v_customer crm.customers;
begin
  select target_customer_id into v_target from crm.owner_session where id = 1 for update;
  update crm.owner_session set target_customer_id = null, expires_at = null, updated_at = now() where id = 1;
  if v_target is null then
    return jsonb_build_object('ok', false, 'error', 'no_active_takeover');
  end if;
  update crm.customers set bot_paused_until = null, updated_at = now() where id = v_target
  returning * into v_customer;
  update crm.escalations set status = 'closed', closed_at = now() where customer_id = v_target and status = 'taken_over';
  return jsonb_build_object('ok', true, 'customer', crm.customer_json(v_customer));
end $$;

-- ─── ops log ──────────────────────────────────────────────────────────────────────────────────

create table if not exists crm.ops_events (
  id         bigint generated always as identity primary key,
  level      text not null default 'info' check (level in ('info', 'warn', 'error')),
  source     text not null,
  message    text not null,
  details    jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ops_events_recent on crm.ops_events (created_at desc);

create or replace function crm.log_event(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  insert into crm.ops_events (level, source, message, details)
  values (coalesce(p->>'level', 'info'), coalesce(p->>'source', 'n8n'), left(coalesce(p->>'message', ''), 2000), p->'details');
  return jsonb_build_object('ok', true);
end $$;

-- ─── inbound entry point ──────────────────────────────────────────────────────────────────────
-- One round trip per inbound message: upsert the sender, de-duplicate, log, and return the state
-- the router needs.
-- p: {wa_message_id, phone?, bsuid?, profile_name?, username?, type, body?, payload?}

create or replace function crm.ingest_inbound(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  c crm.customers;
  v_msg_id bigint;
  v_is_new boolean;
  v_open jsonb;
  v_awaiting_location jsonb;
  v_session jsonb;
begin
  c := crm.upsert_customer(p->>'phone', p->>'bsuid', p->>'profile_name', p->>'username');

  v_is_new := not exists (select 1 from crm.messages where customer_id = c.id and direction = 'out');

  insert into crm.messages (customer_id, direction, wa_message_id, type, body, payload)
  values (c.id, 'in', p->>'wa_message_id', coalesce(p->>'type', 'unknown'), left(p->>'body', 4096), p->'payload')
  on conflict (wa_message_id) where direction = 'in' do nothing
  returning id into v_msg_id;

  if v_msg_id is null then
    return jsonb_build_object('duplicate', true, 'customer', crm.customer_json(c));
  end if;

  select crm.order_json(o) into v_open from crm.orders o
   where o.customer_id = c.id and o.status in ('awaiting_payment', 'payment_review')
   order by o.created_at desc limit 1;

  select crm.order_json(o) into v_awaiting_location from crm.orders o
   where o.customer_id = c.id and o.status = 'paid'
   order by o.paid_at desc nulls last limit 1;

  if c.is_owner then
    select jsonb_build_object('customer', crm.customer_json(t), 'expires_at', s.expires_at) into v_session
      from crm.owner_session s join crm.customers t on t.id = s.target_customer_id
     where s.id = 1 and s.expires_at > now();
  end if;

  return jsonb_build_object(
    'duplicate', false,
    'message_id', v_msg_id,
    'customer', crm.customer_json(c),
    'is_new', v_is_new,
    'open_order', v_open,
    'awaiting_location_order', v_awaiting_location,
    'owner_session', v_session
  );
end $$;

-- ─── housekeeping ─────────────────────────────────────────────────────────────────────────────

-- Unpaid orders worth one gentle reminder: 3–20 h old, never reminded, customer's 24 h window
-- still open (so the reminder is a free-form message, not a paid template).
create or replace function crm.orders_due_for_reminder(p jsonb default '{}'::jsonb)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('order', crm.order_json(o), 'customer', crm.customer_json(c))), '[]'::jsonb)
    from crm.orders o join crm.customers c on c.id = o.customer_id
   where o.status = 'awaiting_payment' and o.reminder_sent_at is null
     and o.created_at < now() - make_interval(hours => coalesce((p->>'after_hours')::int, 3))
     and o.created_at > now() - interval '20 hours'
     and c.opted_out_at is null
     and c.last_inbound_at > now() - interval '23 hours'
$$;

create or replace function crm.mark_reminded(p jsonb)
returns jsonb
language sql security definer set search_path = ''
as $$
  update crm.orders set reminder_sent_at = now(), updated_at = now() where id = (p->>'order_id')::bigint
  returning jsonb_build_object('ok', true)
$$;

-- p: {expire_after_hours?, screenshot_days?, message_days?}
create or replace function crm.housekeeping(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_expired int;
  v_images int;
  v_messages int;
  v_takeover int;
begin
  update crm.orders set status = 'expired', updated_at = now()
   where status = 'awaiting_payment'
     and created_at < now() - make_interval(hours => coalesce((p->>'expire_after_hours')::int, 48));
  get diagnostics v_expired = row_count;

  -- screenshots are needed only until the owner has decided; keep a short audit window
  update crm.payments set image = null
   where image is not null
     and created_at < now() - make_interval(days => coalesce((p->>'screenshot_days')::int, 30));
  get diagnostics v_images = row_count;

  delete from crm.messages
   where created_at < now() - make_interval(days => coalesce((p->>'message_days')::int, 180));
  get diagnostics v_messages = row_count;

  update crm.customers c set bot_paused_until = null
    from crm.owner_session s
   where s.id = 1 and s.expires_at <= now() and c.id = s.target_customer_id;
  update crm.owner_session set target_customer_id = null, expires_at = null
   where id = 1 and expires_at <= now();
  get diagnostics v_takeover = row_count;

  return jsonb_build_object('expired_orders', v_expired, 'purged_screenshots', v_images,
                            'deleted_messages', v_messages, 'ended_takeovers', v_takeover);
end $$;

-- Read-only view for the team (admin role only; the bot role has no table access).
create or replace view crm.v_orders as
  select o.code, o.status, o.total, o.currency, o.items, o.customer_name,
         coalesce(c.display_name, c.profile_name) as customer, c.wa_id,
         o.delivery_location, o.delivery_note, o.created_at, o.paid_at, o.delivered_at
    from crm.orders o join crm.customers c on c.id = o.customer_id
   order by o.created_at desc;

commit;
