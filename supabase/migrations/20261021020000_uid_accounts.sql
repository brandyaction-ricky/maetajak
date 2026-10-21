-- 2026-10-21 Gate UID accounts.
-- Members sign up with their Gate.io UID as the login ID (no email, no email verification).
-- The uid-signup Edge Function creates the auth user with the synthetic, never-mailed email
-- `${uid}@uid.maetajak.trading` (already confirmed) and the UID in user_metadata.gate_uid.
--   * profiles.gate_uid: the account's Gate UID (unique, digits only).
--   * handle_new_user(): production definition + gate_uid from metadata.
--   * auto_approve_confirmed_user(): UID accounts are created confirmed but must stay PENDING
--     until an administrator approves them (anchored patch, no re-typing).
--   * save_gate_api_credentials(): a member with a signup UID can only save that UID
--     (GATE_UID_MUST_MATCH_ACCOUNT; anchored patch of the production definition).
--   * retry_my_gate_api_verification(boolean) takes no UID (it reuses the saved credential),
--     so it cannot change the UID and is left unchanged.
--   * request_member_password_reset(uuid) (recovery email) is no longer used by the UI:
--     administrators issue a temporary password through the admin-reset-password function.
-- Idempotent: safe to run more than once.
set lock_timeout = '5s';

alter table public.profiles add column if not exists gate_uid text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass and conname = 'profiles_gate_uid_format_check'
  ) then
    alter table public.profiles
      add constraint profiles_gate_uid_format_check check (gate_uid ~ '^[0-9]{4,15}$');
  end if;
end;
$$;

create unique index if not exists profiles_gate_uid_unique
  on public.profiles (gate_uid) where gate_uid is not null;

comment on column public.profiles.gate_uid is
  'Gate.io UID used as the login ID (auth email = <uid>@uid.maetajak.trading). Null for the administrator and legacy email accounts.';

-- Production definition (pg_get_functiondef, 2026-10-21) plus gate_uid. The UID is taken only
-- when the auth email is the matching synthetic address, so an ordinary email signup cannot
-- claim someone else's UID through metadata.
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare accepted_at timestamptz;
declare accepted_terms_version text;
declare accepted_privacy_version text;
declare signup_gate_uid text;
begin
  accepted_at := nullif(new.raw_user_meta_data ->> 'terms_accepted_at', '')::timestamptz;
  accepted_terms_version := nullif(new.raw_user_meta_data ->> 'terms_version', '');
  accepted_privacy_version := nullif(new.raw_user_meta_data ->> 'privacy_version', '');
  signup_gate_uid := btrim(coalesce(new.raw_user_meta_data ->> 'gate_uid', ''));
  if signup_gate_uid !~ '^[0-9]{4,15}$'
     or lower(coalesce(new.email, '')) <> signup_gate_uid || '@uid.maetajak.trading' then
    signup_gate_uid := null;
  end if;

  insert into public.profiles (
    id, email, full_name, phone, terms_accepted_at, terms_version, privacy_version, gate_uid
  ) values (
    new.id, coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    accepted_at, accepted_terms_version, accepted_privacy_version, signup_gate_uid
  ) on conflict (id) do nothing;

  if accepted_at is not null and accepted_terms_version is not null then
    insert into public.legal_acceptances (user_id, document_type, document_version, accepted_at)
    values (new.id, 'TERMS', accepted_terms_version, accepted_at)
    on conflict (user_id, document_type, document_version) do nothing;
  end if;
  if accepted_at is not null and accepted_privacy_version is not null then
    insert into public.legal_acceptances (user_id, document_type, document_version, accepted_at)
    values (new.id, 'PRIVACY', accepted_privacy_version, accepted_at)
    on conflict (user_id, document_type, document_version) do nothing;
  end if;
  return new;
end;
$function$;

-- UID accounts are created with email_confirm = true (there is no mailbox), which would fire
-- the email-confirmation auto-approval. Keep them PENDING for the administrator instead.
do $patch$
declare
  target regprocedure := 'public.auto_approve_confirmed_user()'::regprocedure;
  definition text := pg_get_functiondef(target);
  anchor text := $anchor$  if new.email_confirmed_at is null then
    return new;
  end if;
$anchor$;
  replacement text := $replacement$  if new.email_confirmed_at is null then
    return new;
  end if;
  -- Gate UID accounts (synthetic email, created confirmed) wait for administrator approval.
  if lower(coalesce(new.email, '')) like '%@uid.maetajak.trading' then
    return new;
  end if;
$replacement$;
  occurrences integer;
begin
  if position('@uid.maetajak.trading' in definition) > 0 then
    raise notice 'auto_approve_confirmed_user already patched';
    return;
  end if;
  occurrences := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if occurrences <> 1 then
    raise exception 'auto_approve_confirmed_user anchor found % times (expected 1)', occurrences;
  end if;
  execute replace(definition, anchor, replacement);
end;
$patch$;

-- A member whose account was created with a Gate UID can connect only that UID.
do $patch$
declare
  target regprocedure := 'public.save_gate_api_credentials(text,text,text,boolean)'::regprocedure;
  definition text := pg_get_functiondef(target);
  anchor text := $anchor$  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  perform private.guard_gate_account_change(auth.uid(), 'MEMBER', p_gate_uid);
$anchor$;
  replacement text := $replacement$  if exists (
    select 1 from public.profiles
    where id = auth.uid() and gate_uid is not null and gate_uid is distinct from trim(p_gate_uid)
  ) then raise exception 'GATE_UID_MUST_MATCH_ACCOUNT'; end if;

  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  perform private.guard_gate_account_change(auth.uid(), 'MEMBER', p_gate_uid);
$replacement$;
  occurrences integer;
begin
  if position('GATE_UID_MUST_MATCH_ACCOUNT' in definition) > 0 then
    raise notice 'save_gate_api_credentials already patched';
    return;
  end if;
  occurrences := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if occurrences <> 1 then
    raise exception 'save_gate_api_credentials anchor found % times (expected 1)', occurrences;
  end if;
  execute replace(definition, anchor, replacement);
end;
$patch$;

-- The recovery-email reset is retired for members; keep the function for the record but
-- stop exposing it to signed-in users.
do $$
begin
  if to_regprocedure('public.request_member_password_reset(uuid)') is not null then
    revoke execute on function public.request_member_password_reset(uuid) from public, anon, authenticated;
  end if;
end;
$$;

reset lock_timeout;
