do $mig$
declare def_cro text; def_oco text; m1 text; m2 text;
begin
  select md5(prosrc) into m1 from pg_proc where oid='private.copy_resume_ownership(uuid,uuid,jsonb,jsonb)'::regprocedure;
  select md5(prosrc) into m2 from pg_proc where oid='private.observe_copy_ownership()'::regprocedure;
  if m1 is distinct from 'c7a3a26ad0d5692a41bf292b1d4cf832' or m2 is distinct from '4e90dd05f9359ec016d968bda3610d70' then
    raise exception 'ABORT_BASE_FUNCTION_DRIFT cro=% oco=%', m1, m2;
  end if;
  def_cro := pg_get_functiondef('private.copy_resume_ownership(uuid,uuid,jsonb,jsonb)'::regprocedure);
  def_oco := pg_get_functiondef('private.observe_copy_ownership()'::regprocedure);
  def_cro := replace(def_cro, '(i.filled_size<>0 and i.observation_confirmed_at is null)', '(i.filled_size<>0 and i.observation_confirmed_at is null and i.resume_version is not null)');
  def_cro := replace(def_cro, 'trading_account_id=p_account and i.filled_size<>0', 'trading_account_id=p_account and i.filled_size<>0 and i.resume_version is not null');
  def_cro := replace(def_cro, 'trading_account_id=p_account and filled_size<>0', 'trading_account_id=p_account and filled_size<>0 and resume_version is not null');
  def_oco := replace(def_oco, '(i.filled_size<>0 and i.observation_confirmed_at is null)', '(i.filled_size<>0 and i.observation_confirmed_at is null and i.resume_version is not null)');
  def_oco := replace(def_oco, 'trading_account_id=new.trading_account_id and i.filled_size<>0', 'trading_account_id=new.trading_account_id and i.filled_size<>0 and i.resume_version is not null');
  execute def_cro;
  execute def_oco;
  select md5(prosrc) into m1 from pg_proc where oid='private.copy_resume_ownership(uuid,uuid,jsonb,jsonb)'::regprocedure;
  select md5(prosrc) into m2 from pg_proc where oid='private.observe_copy_ownership()'::regprocedure;
  if m1 is distinct from '03b6c2f44ba6709c9015dc7f1a979915' or m2 is distinct from '14896b3e33341e8e79154f170ba2205a' then
    raise exception 'POST_MD5_MISMATCH cro=% oco=%', m1, m2;
  end if;
end $mig$;