# 실거래 Worker 배포 안내

현재 Vercel은 화면, Supabase는 인증·DB를 담당합니다. Gate.io 주문은 **고정 공인 IPv4를 가진 별도 Worker 한 대**에서만 전송합니다. 브라우저나 Vercel에서는 API Secret을 읽거나 주문하지 않습니다.

## 운영 전 필수 체크

1. 서울 리전 VPS 1대를 만들고 고정 IPv4를 연결합니다.
2. 서버 `/opt/maetajak/.env.worker`에만 Supabase Service Role Key를 저장합니다.
3. Master와 모든 회원의 Gate.io API Whitelist에 같은 Worker IPv4를 등록합니다.
4. API 권한은 Trading Account의 Perpetual Futures Read/Write만 사용하고 그 외 쓰기 권한과 Withdrawal은 비활성화합니다.
5. `OBSERVE`에서 계정·포지션 조회를 확인하고, `DRY_RUN`에서 목표 포지션과 Delta가 맞는지 확인합니다.
6. 소액 전용 계정으로 주문·부분 체결·취소·네트워크 타임아웃·긴급중단을 검증합니다.
7. 마지막에만 `LIVE` 모드와 실행 활성화를 적용합니다.

## 설치

```bash
sudo mkdir -p /opt/maetajak
sudo chown "$USER":"$USER" /opt/maetajak
git clone https://github.com/brandyaction-ricky/maetajak.git /opt/maetajak
cd /opt/maetajak
cp .env.worker.example .env.worker
chmod 600 .env.worker
```

`.env.worker`에서 `SUPABASE_SERVICE_ROLE_KEY`, 실제 고정 `WORKER_PUBLIC_IP`를 입력합니다. 이 파일은 Git에 올리지 않습니다. 회원과 Master API 연결 검증은 Gate.io의 `account/detail`과 `account/main_keys`를 조회해 Worker IP Whitelist, 활성 Key 상태, Futures Read/Write, 불필요한 쓰기 권한 비활성화를 실제 응답으로 확인합니다.

장애를 사이트 밖에서도 즉시 확인하려면 `ALERT_WEBHOOK_URL`을 운영 알림 Webhook으로 설정합니다. 수신 서버가 Bearer 인증을 지원하면 `ALERT_WEBHOOK_BEARER`도 함께 설정합니다. 전송 내용에는 API Key·Secret Key·Service Role Key가 포함되지 않습니다.

```bash
docker compose -f docker-compose.worker.yml up -d --build
docker compose -f docker-compose.worker.yml logs -f --tail=100
```

## 단계별 전환

- 1차: `TRADING_MODE=OBSERVE`, `RUN_READINESS_CHECK=false`
- 2차: 조회·계산 검증 후 `TRADING_MODE=DRY_RUN`, `RUN_READINESS_CHECK=true` (`OBSERVE`나 `LIVE`에서는 준비 완료 시각을 기록할 수 없습니다.)
- 3차: 테스트 완료 후 `TRADING_MODE=LIVE`, `RUN_READINESS_CHECK=false`
- 마지막 활성화:

```bash
COPY_ACTIVATION_CONFIRMATION=ENABLE_LIVE_COPY_TRADING npm run worker:activate
```

DB는 최근 Worker heartbeat, 운영 Gate URL, 고정 IP, 최근 준비 테스트, 검증된 Master와 회원이 모두 확인될 때만 활성화를 허용합니다. Worker heartbeat가 30초 넘게 끊긴 상태에서 주문을 가져오려 하면 자동으로 전체 실행이 중단됩니다.

## 긴급 중단

```bash
COPY_HALT_REASON=OPERATOR_EMERGENCY_HALT npm run worker:halt
```

`UNKNOWN` 주문은 같은 Delta를 즉시 다시 보내지 않습니다. Gate 주문 ID 또는 고유 주문 `text`로 조회해 결과가 확인된 뒤에만 다음 동기화를 진행합니다. 주문 요청 직후 Worker가 중단되어 DB 기록을 남기지 못한 `SUBMITTING` 주문도 30초 뒤 자동으로 Reconciliation 큐로 이동합니다.
