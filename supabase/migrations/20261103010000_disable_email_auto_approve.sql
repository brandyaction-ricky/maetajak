-- 2026-11-03 pre-go-live QA Q2 (P1): no member account is approved automatically.
--
-- Production trigger zz_auto_approve_confirmed_user (AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users,
-- WHEN new.email_confirmed_at IS NOT NULL) runs public.auto_approve_confirmed_user(). Its production body
-- (pg_get_functiondef 2026-11-03 = 202609020002 + the 20261021020000 UID patch) set a confirmed non-UID (email)
-- MEMBER from PENDING to APPROVED and wrote a USER_AUTO_APPROVED_EMAIL_CONFIRMED audit row. Gate UID accounts
-- (...@uid.maetajak.trading) already stayed PENDING.
--
-- From now on every MEMBER account (email or Gate UID) stays PENDING until an administrator approves it
-- (set_user_approval). The function only returns NEW. Profiles already APPROVED are not touched.
--
-- The trigger is kept (CREATE OR REPLACE keeps the function's owner and grants), so this is reversible by replacing
-- the function body again. To restore the previous behaviour, re-create the body below:
--
--   declare changed_profile public.profiles;
--   begin
--     if new.email_confirmed_at is null then
--       return new;
--     end if;
--     -- Gate UID accounts (synthetic email, created confirmed) wait for administrator approval.
--     if lower(coalesce(new.email, '')) like '%@uid.maetajak.trading' then
--       return new;
--     end if;
--     update public.profiles
--     set approval_status = 'APPROVED', approved_at = coalesce(approved_at, new.email_confirmed_at, now()),
--         approved_by = null, updated_at = now()
--     where id = new.id and role = 'MEMBER' and approval_status = 'PENDING'
--     returning * into changed_profile;
--     if found then
--       insert into public.admin_audit_logs (actor_id, action, target_user_id, previous_value, next_value)
--       values (null, 'USER_AUTO_APPROVED_EMAIL_CONFIRMED', new.id,
--         jsonb_build_object('approval_status', 'PENDING'), to_jsonb(changed_profile));
--     end if;
--     return new;
--   end;
--
-- Idempotent (CREATE OR REPLACE only). No table, row, trigger or grant is changed.
set lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.auto_approve_confirmed_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  -- 2026-11-03 Q2: email confirmation no longer approves anything. Email accounts and Gate UID accounts
  -- (synthetic '%@uid.maetajak.trading' email, created confirmed) alike stay PENDING until an administrator
  -- approves them. The trigger is kept so the previous body can be restored (see the migration header).
  return new;
end;
$function$;

comment on function public.auto_approve_confirmed_user() is
  'Trigger function of zz_auto_approve_confirmed_user. Since 2026-11-03 (Q2) it approves nothing: every member stays PENDING until an administrator approves it.';
