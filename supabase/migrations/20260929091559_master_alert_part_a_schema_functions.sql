-- REPO RECORD ONLY. Already applied in production on 2026-09-29 (version 20260929091559,
-- name master_alert_part_a_schema_functions); restored into the repo on 2026-10-20 to close repo drift.
-- Text below is the applied migration verbatim (supabase_migrations.schema_migrations.statements); on
-- 2026-10-20 it matched the live catalog (function bodies, proconfig, ACLs, columns, defaults, indexes).
-- Not part of tests/fixtures migrationFiles: the cron/pg_net/vault side is not available in PGlite.
-- ---- applied text starts below ----
-- master_alert — 마스터 계정 포지션 진입/청산 알림 (독립·읽기전용)
-- 거래 테이블·주문 경로 미접촉. private.copy_current_positions / copy_current_accounts (MASTER) 읽기만.

create schema if not exists master_alert;
revoke all on schema master_alert from public, anon, authenticated;

create table if not exists master_alert.config (
  id                  boolean primary key default true check (id),
  enabled             boolean not null default true,
  baseline_seeded     boolean not null default false,
  freshness_seconds   integer not null default 120,
  min_delta_notional  numeric not null default 0,
  updated_at          timestamptz not null default now()
);
insert into master_alert.config (id) values (true) on conflict (id) do nothing;

create table if not exists master_alert.position_state (
  contract               text not null,
  position_side          text not null,
  confirmed_size         numeric not null default 0,
  confirmed_at           timestamptz,
  pending_size           numeric,
  pending_since          timestamptz,
  last_observed_size     numeric,
  last_observed_at       timestamptz,
  last_entry_price       numeric,
  last_mark_price        numeric,
  last_leverage          numeric,
  last_quanto_multiplier numeric,
  updated_at             timestamptz not null default now(),
  primary key (contract, position_side)
);

create table if not exists master_alert.entry_outbox (
  id               bigint generated always as identity primary key,
  event_type       text not null check (event_type in ('ENTRY_OPEN','ENTRY_ADD','REDUCE','CLOSE')),
  contract         text not null,
  position_side    text not null,
  size_before      numeric not null,
  size_after       numeric not null,
  delta_notional   numeric,
  entry_price      numeric,
  mark_price       numeric,
  message          text not null,
  observed_at      timestamptz,
  attempts         integer not null default 0,
  claimed_at       timestamptz,
  next_attempt_at  timestamptz not null default now(),
  delivered_at     timestamptz,
  last_error_code  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists ix_master_alert_outbox_pending
  on master_alert.entry_outbox (next_attempt_at) where delivered_at is null;

alter table master_alert.config         enable row level security;
alter table master_alert.position_state enable row level security;
alter table master_alert.entry_outbox   enable row level security;

create or replace function master_alert._emit(
  p_contract text, p_side text, p_before numeric, p_after numeric,
  p_entry numeric, p_mark numeric, p_lev numeric, p_mult numeric,
  p_obs_at timestamptz, p_min_delta_notional numeric
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_abs_before numeric := abs(coalesce(p_before, 0));
  v_abs_after  numeric := abs(coalesce(p_after, 0));
  v_exp_delta  numeric := abs(coalesce(p_after, 0)) - abs(coalesce(p_before, 0));
  v_px         numeric := coalesce(p_mark, p_entry);
  v_notional   numeric;
  v_type text; v_label text; v_emoji text; v_px_line text; v_msg text;
  v_kst text := to_char(coalesce(p_obs_at, now()) at time zone 'Asia/Seoul', 'MM-DD HH24:MI');
begin
  if coalesce(p_before, 0) = coalesce(p_after, 0) then
    return false;
  end if;

  v_notional := case when v_px is null then null
                     else round(abs(v_exp_delta) * coalesce(p_mult, 1) * v_px, 2) end;

  if v_abs_after = 0 then
    v_type := 'CLOSE'; v_emoji := '⚪'; v_label := '전량 청산';
  elsif v_abs_before = 0 then
    v_type  := 'ENTRY_OPEN';
    v_emoji := case when p_side = 'SHORT' then '🔴' else '🟢' end;
    v_label := case when p_side = 'SHORT' then '신규 진입 (매도)' else '신규 진입 (매수)' end;
  elsif v_abs_after > v_abs_before then
    v_type  := 'ENTRY_ADD';
    v_emoji := case when p_side = 'SHORT' then '🔴' else '🟢' end;
    v_label := case when p_side = 'SHORT' then '추가 매도' else '추가 매수' end;
  else
    v_type := 'REDUCE'; v_emoji := '🟠'; v_label := '부분 청산';
  end if;

  if coalesce(p_min_delta_notional, 0) > 0
     and v_type in ('ENTRY_ADD', 'REDUCE')
     and coalesce(v_notional, 0) < p_min_delta_notional then
    return false;
  end if;

  v_px_line := case v_type
    when 'ENTRY_OPEN' then '진입가 ' || coalesce(trim_scale(round(p_entry, 6))::text, '-')
                           || ' · ' || coalesce(trim_scale(p_lev)::text, '-') || 'x'
    when 'CLOSE'      then '직전 평단 ' || coalesce(trim_scale(round(p_entry, 6))::text, '-')
                           || ' · 직전가 ' || coalesce(trim_scale(round(p_mark, 6))::text, '-')
    else                   '평단 ' || coalesce(trim_scale(round(p_entry, 6))::text, '-')
                           || ' · 현재가 ' || coalesce(trim_scale(round(p_mark, 6))::text, '-')
                           || ' · ' || coalesce(trim_scale(p_lev)::text, '-') || 'x'
  end;

  v_msg := v_emoji || ' [마스터] ' || v_label || ' · ' || p_side || ' ' || p_contract || chr(10)
        || '수량 ' || trim_scale(v_abs_before) || ' → ' || trim_scale(v_abs_after)
        || ' (' || case when v_exp_delta > 0 then '+' else '' end || trim_scale(v_exp_delta) || ')'
        || coalesce(' ≈ ' || to_char(v_notional, 'FM999,999,999,990.00') || ' USDT', '') || chr(10)
        || v_px_line || chr(10)
        || v_kst || ' KST';

  insert into master_alert.entry_outbox
    (event_type, contract, position_side, size_before, size_after, delta_notional,
     entry_price, mark_price, message, observed_at)
  values
    (v_type, p_contract, p_side, coalesce(p_before, 0), coalesce(p_after, 0), v_notional,
     p_entry, p_mark, v_msg, p_obs_at);

  return true;
end;
$$;

create or replace function master_alert.tick()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_cfg     master_alert.config%rowtype;
  v_master  uuid;
  v_obs_at  timestamptz;
  v_emitted integer := 0;
  v_pending integer := 0;
  v_ok      boolean;
  r         record;
begin
  if not pg_try_advisory_xact_lock(hashtext('master_alert.tick')) then
    return jsonb_build_object('skipped', 'locked');
  end if;

  select * into v_cfg from master_alert.config where id;
  if not found or not v_cfg.enabled then
    return jsonb_build_object('skipped', 'disabled');
  end if;

  select a.trading_account_id, a.observed_at
    into v_master, v_obs_at
  from private.copy_current_accounts a
  where a.account_role = 'MASTER'
  order by a.observed_at desc
  limit 1;

  if v_master is null then
    return jsonb_build_object('skipped', 'no_master');
  end if;
  if v_obs_at < now() - make_interval(secs => v_cfg.freshness_seconds) then
    return jsonb_build_object('skipped', 'stale', 'observed_at', v_obs_at);
  end if;

  if not v_cfg.baseline_seeded then
    insert into master_alert.position_state as s
      (contract, position_side, confirmed_size, confirmed_at,
       last_observed_size, last_observed_at, last_entry_price, last_mark_price,
       last_leverage, last_quanto_multiplier, updated_at)
    select p.contract, p.position_side, p.size, now(),
           p.size, p.observed_at, p.entry_price, p.mark_price,
           p.leverage, p.quanto_multiplier, now()
    from private.copy_current_positions p
    where p.trading_account_id = v_master and p.account_role = 'MASTER'
    on conflict (contract, position_side) do update
      set confirmed_size = excluded.confirmed_size, confirmed_at = now(),
          pending_size = null, pending_since = null,
          last_observed_size = excluded.last_observed_size,
          last_observed_at = excluded.last_observed_at,
          last_entry_price = excluded.last_entry_price,
          last_mark_price = excluded.last_mark_price,
          last_leverage = excluded.last_leverage,
          last_quanto_multiplier = excluded.last_quanto_multiplier,
          updated_at = now();
    update master_alert.config set baseline_seeded = true, updated_at = now() where id;
    return jsonb_build_object('seeded', true, 'observed_at', v_obs_at);
  end if;

  for r in
    with obs as (
      select p.contract, p.position_side, p.size, p.entry_price, p.mark_price,
             p.leverage, p.quanto_multiplier, p.observed_at
      from private.copy_current_positions p
      where p.trading_account_id = v_master and p.account_role = 'MASTER'
    ),
    keys as (
      select contract, position_side from obs
      union
      select contract, position_side from master_alert.position_state
      where confirmed_size <> 0 or pending_size is not null
    )
    select k.contract, k.position_side,
           coalesce(o.size, 0)                                     as obs_size,
           coalesce(o.entry_price, s.last_entry_price)             as entry_price,
           coalesce(o.mark_price, s.last_mark_price)               as mark_price,
           coalesce(o.leverage, s.last_leverage)                   as leverage,
           coalesce(o.quanto_multiplier, s.last_quanto_multiplier) as mult,
           coalesce(o.observed_at, v_obs_at)                       as obs_at,
           (o.contract is not null)                                as present,
           coalesce(s.confirmed_size, 0)                           as confirmed_size,
           s.pending_size
    from keys k
    left join obs o
           on o.contract = k.contract and o.position_side = k.position_side
    left join master_alert.position_state s
           on s.contract = k.contract and s.position_side = k.position_side
  loop
    if r.obs_size = r.confirmed_size then
      update master_alert.position_state
         set pending_size = null, pending_since = null,
             last_observed_size = r.obs_size, last_observed_at = r.obs_at,
             last_entry_price = case when r.present then r.entry_price else last_entry_price end,
             last_mark_price  = case when r.present then r.mark_price  else last_mark_price  end,
             last_leverage    = case when r.present then r.leverage    else last_leverage    end,
             last_quanto_multiplier = case when r.present then r.mult else last_quanto_multiplier end,
             updated_at = now()
       where contract = r.contract and position_side = r.position_side;

    elsif r.pending_size is distinct from r.obs_size then
      insert into master_alert.position_state as s
        (contract, position_side, confirmed_size, pending_size, pending_since,
         last_observed_size, last_observed_at, last_entry_price, last_mark_price,
         last_leverage, last_quanto_multiplier, updated_at)
      values
        (r.contract, r.position_side, r.confirmed_size, r.obs_size, now(),
         r.obs_size, r.obs_at, r.entry_price, r.mark_price,
         r.leverage, r.mult, now())
      on conflict (contract, position_side) do update
        set pending_size = excluded.pending_size, pending_since = now(),
            last_observed_size = excluded.last_observed_size,
            last_observed_at = excluded.last_observed_at,
            last_entry_price = coalesce(excluded.last_entry_price, s.last_entry_price),
            last_mark_price  = coalesce(excluded.last_mark_price,  s.last_mark_price),
            last_leverage    = coalesce(excluded.last_leverage,    s.last_leverage),
            last_quanto_multiplier = coalesce(excluded.last_quanto_multiplier, s.last_quanto_multiplier),
            updated_at = now();
      v_pending := v_pending + 1;

    else
      v_ok := master_alert._emit(r.contract, r.position_side, r.confirmed_size, r.obs_size,
                                 r.entry_price, r.mark_price, r.leverage, r.mult,
                                 r.obs_at, v_cfg.min_delta_notional);
      update master_alert.position_state
         set confirmed_size = r.obs_size, confirmed_at = now(),
             pending_size = null, pending_since = null,
             last_observed_size = r.obs_size, last_observed_at = r.obs_at,
             updated_at = now()
       where contract = r.contract and position_side = r.position_side;
      if v_ok then v_emitted := v_emitted + 1; end if;
    end if;
  end loop;

  return jsonb_build_object('emitted', v_emitted, 'pending', v_pending, 'observed_at', v_obs_at);
end;
$$;

create or replace function public.master_alert_claim(p_max integer default 20)
returns table (id bigint, message text)
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  update master_alert.entry_outbox e
     set claimed_at = now(), attempts = e.attempts + 1, updated_at = now()
   where e.id in (
     select o.id
       from master_alert.entry_outbox o
      where o.delivered_at is null
        and o.next_attempt_at <= now()
        and (o.claimed_at is null or o.claimed_at < now() - interval '2 minutes')
      order by o.id
      limit greatest(1, least(coalesce(p_max, 20), 50))
      for update skip locked
   )
  returning e.id, e.message;
$$;

create or replace function public.master_alert_mark(
  p_delivered bigint[] default '{}'::bigint[],
  p_failed    jsonb    default '[]'::jsonb
) returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update master_alert.entry_outbox
     set delivered_at = now(), last_error_code = null, claimed_at = null, updated_at = now()
   where id = any(coalesce(p_delivered, '{}'::bigint[]))
     and delivered_at is null;

  update master_alert.entry_outbox e
     set last_error_code = left(f.err, 120),
         claimed_at = null,
         next_attempt_at = now() + make_interval(secs => least(600, (15 * power(2, least(e.attempts, 6)))::int)),
         updated_at = now()
    from (
      select (x ->> 'id')::bigint as id, x ->> 'err' as err
        from jsonb_array_elements(coalesce(p_failed, '[]'::jsonb)) x
    ) f
   where e.id = f.id and e.delivered_at is null;
end;
$$;

create or replace function public.master_alert_config()
returns table (bot_token text, chat_id text, cron_secret text, enabled boolean)
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select
    (select ds.decrypted_secret from vault.decrypted_secrets ds where ds.name = 'master_alert_bot_token'),
    (select ds.decrypted_secret from vault.decrypted_secrets ds where ds.name = 'master_alert_chat_id'),
    (select ds.decrypted_secret from vault.decrypted_secrets ds where ds.name = 'master_alert_cron_secret'),
    (select c.enabled from master_alert.config c where c.id);
$$;

revoke all on function master_alert.tick() from public, anon, authenticated;
revoke all on function master_alert._emit(text, text, numeric, numeric, numeric, numeric, numeric, numeric, timestamptz, numeric) from public, anon, authenticated;
revoke all on function public.master_alert_claim(integer) from public, anon, authenticated;
revoke all on function public.master_alert_mark(bigint[], jsonb) from public, anon, authenticated;
revoke all on function public.master_alert_config() from public, anon, authenticated;
grant execute on function public.master_alert_claim(integer) to service_role;
grant execute on function public.master_alert_mark(bigint[], jsonb) to service_role;
grant execute on function public.master_alert_config() to service_role;
