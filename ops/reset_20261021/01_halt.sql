-- STEP 1 / 2  (2026-10-21 데이터 초기화 전 정지)
-- Supabase SQL Editor에서 이 파일만 먼저 실행 → 1분 대기 → 02_backup_and_wipe.sql 실행.
-- 효과: 카피 실행 OFF + 비상정지. 워커는 다음 루프부터 주문을 내지 않는다.
update public.copy_system_control
   set execution_enabled = false,
       emergency_halted  = true,
       halt_reason       = 'DATA_RESET_20261021',
       updated_at        = now()
 where singleton;

select execution_enabled, emergency_halted, halt_reason, updated_at
  from public.copy_system_control;
-- 기대값: false | true | DATA_RESET_20261021
