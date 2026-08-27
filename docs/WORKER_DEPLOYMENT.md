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

## Gate 계정과 Broker 귀속

- 추천인 계정 UID: `45997867` - 신규 회원은 이 계정의 추천 링크로 가입합니다.
- API Broker 커미션 수령 UID: `49084031` - Channel ID `maetajak`에 귀속된 20%를 수령합니다.
- API Broker Channel ID: `maetajak` - Worker가 모든 회원 Futures 주문 헤더에 `X-Gate-Channel-Id: maetajak`를 자동 주입합니다.
- Futures decimal size: 최신 Gate API 규격에 맞춰 인증된 Futures 요청에 `X-Gate-Size-Decimal: 1`을 자동 주입합니다.
- Master UID: 실제 신호 원본으로 사용할 Gate 계정 UID를 관리자 화면에 연결합니다. 추천인 UID나 Broker 수령 UID와 반드시 같을 필요는 없습니다.

Gate 가이드상 자기 Channel ID를 사용한 API Broker 본인 계정의 거래에는 Broker 리베이트가 발생하지 않습니다. 회원 거래는 추천 링크와 Channel ID를 모두 충족해야 추천 리베이트와 API Broker 리베이트가 함께 귀속됩니다.

## 설치

### AWS Lightsail (권장 운영 구성)

서울 리전에서 Linux/Unix `OS Only → Ubuntu` 인스턴스를 만든 뒤 Static IP를 연결합니다. 이 Worker는 외부 요청을 받는 웹서버가 아니므로 HTTP/HTTPS 포트를 열지 않습니다. Lightsail IPv4 방화벽은 SSH 22번만 운영자 IP로 제한하고 IPv6는 비활성화합니다.

인스턴스 생성 화면의 Launch script에는 `deploy/lightsail-bootstrap.sh` 내용을 사용합니다. 부팅 완료 후 Lightsail 브라우저 SSH에서 아래 명령으로 운영 환경을 입력합니다. Service Role Key와 알림 Webhook은 화면에 표시되지 않으며 `/etc/maetajak/worker.env`에 root 전용 `600` 권한으로 저장됩니다.

```bash
sudo /opt/maetajak/deploy/lightsail-configure.sh
```

설정 스크립트는 서버의 실제 외부 IPv4를 AWS 엔드포인트로 확인하고 `OBSERVE` 모드만 기동합니다. Gate.io에는 스크립트가 마지막에 표시한 동일 IPv4를 Master와 모든 회원 API Whitelist에 등록합니다.

상태 확인과 검토된 수동 업데이트는 다음 명령만 사용합니다.

```bash
sudo /opt/maetajak/deploy/lightsail-status.sh
sudo /opt/maetajak/deploy/lightsail-update.sh
```

서버 업데이트는 자동 배포하지 않습니다. 화면 코드 배포와 달리 Worker 업데이트는 주문 실행에 영향을 줄 수 있으므로 Preflight 통과 후 명시적으로 재시작합니다.

### 일반 Docker 서버

```bash
sudo mkdir -p /opt/maetajak
sudo chown "$USER":"$USER" /opt/maetajak
git clone https://github.com/brandyaction-ricky/maetajak.git /opt/maetajak
cd /opt/maetajak
cp .env.worker.example .env.worker
chmod 600 .env.worker
```

`.env.worker`에서 `SUPABASE_SERVICE_ROLE_KEY`, 실제 고정 `WORKER_PUBLIC_IP`를 입력하고 `GATE_CHANNEL_ID=maetajak`를 유지합니다. 이 파일은 Git에 올리지 않습니다. 회원과 Master API 연결 검증은 Gate.io의 `account/detail`과 `account/main_keys`를 조회해 Worker IP Whitelist, 활성 Key 상태, Futures Read/Write, 불필요한 쓰기 권한 비활성화를 실제 응답으로 확인합니다.

`DRY_RUN`과 `LIVE`는 Channel ID가 없거나 형식이 잘못되면 Worker 시작 단계에서 차단됩니다. 운영 DB도 승인된 Channel ID와 Worker의 Channel ID가 정확히 일치해야 준비 테스트 기록과 실거래 활성화를 허용합니다.

장애를 사이트 밖에서도 즉시 확인하려면 `ALERT_WEBHOOK_URL`을 운영 알림 Webhook으로 설정합니다. 수신 서버가 Bearer 인증을 지원하면 `ALERT_WEBHOOK_BEARER`도 함께 설정합니다. 전송 내용에는 API Key·Secret Key·Service Role Key가 포함되지 않습니다.

```bash
docker compose -f docker-compose.worker.yml run --rm copy-worker npm run worker:preflight
docker compose -f docker-compose.worker.yml up -d --build
docker compose -f docker-compose.worker.yml logs -f --tail=100
```

Preflight가 `ok: true`를 반환하기 전에는 Worker를 시작하지 않습니다. 고정 공인 IPv4, 운영 Supabase Service Role, Gate 운영 URL, 승인 Channel ID, 모드별 준비 설정을 검사하며, LIVE에서는 외부 장애 알림 Webhook도 필수입니다. 출력에는 Secret이나 Service Role Key가 포함되지 않습니다.

## 단계별 전환

- 1차: `TRADING_MODE=OBSERVE`, `RUN_READINESS_CHECK=false`
- 2차: 조회·계산 검증 후 `TRADING_MODE=DRY_RUN`, `RUN_READINESS_CHECK=true` (`OBSERVE`나 `LIVE`에서는 준비 완료 시각을 기록할 수 없습니다.)
- 3차: 테스트 완료 후 `TRADING_MODE=LIVE`, `RUN_READINESS_CHECK=false`
- 마지막 활성화:

```bash
COPY_ACTIVATION_CONFIRMATION=ENABLE_LIVE_COPY_TRADING npm run worker:activate
```

DB는 최근 Worker heartbeat, 운영 Gate URL, 고정 IP, 최근 준비 테스트, 검증된 Master와 회원이 모두 확인될 때만 활성화를 허용합니다. Worker heartbeat가 30초 넘게 끊긴 상태에서 주문을 가져오려 하면 자동으로 전체 실행이 중단됩니다.

`OBSERVE`와 `DRY_RUN`에서는 Target/Actual/Delta만 기록하고 실행 가능한 주문 의도는 저장하지 않습니다. 또한 LIVE 활성화 시각 이전에 생성된 모든 주문 의도는 DB에서 가져올 수 없으므로, 테스트 중 계산된 Delta가 나중에 실주문으로 바뀌지 않습니다. 준비 완료 시각은 Master 포지션에서 실제 Delta가 한 건 이상 계산된 DRY_RUN에만 기록됩니다.

## 긴급 중단

```bash
COPY_HALT_REASON=OPERATOR_EMERGENCY_HALT npm run worker:halt
```

`UNKNOWN` 주문은 같은 Delta를 즉시 다시 보내지 않습니다. Gate 주문 ID 또는 고유 주문 `text`로 조회해 결과가 확인된 뒤에만 다음 동기화를 진행합니다. 주문 요청 직후 Worker가 중단되어 DB 기록을 남기지 못한 `SUBMITTING` 주문도 30초 뒤 자동으로 Reconciliation 큐로 이동합니다.
