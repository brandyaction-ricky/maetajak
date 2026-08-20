# maetajak

Private Gate.io copy-trading platform UI. The current application uses Supabase Auth and a server-enforced approval profile before granting access to member or administrator screens.

## Local setup

1. Create a Supabase project.
2. Run the SQL files in `supabase/migrations` in filename order in the Supabase SQL Editor.
3. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Run `npm install` and `npm run dev`.

The Supabase anon key is intended for browser use. Authorization is enforced by Row Level Security. Never add a service-role key or Gate.io secret to a `VITE_` environment variable.

## First administrator

Create the administrator through the normal sign-up screen, then run this statement once in the Supabase SQL Editor:

```sql
update public.profiles
set role = 'ADMIN', approval_status = 'APPROVED', approved_at = now()
where email = 'ADMIN_EMAIL';
```

After this bootstrap, the approved administrator can approve or reject pending members from the member-management screen. Each approval change is written to `admin_audit_logs`.

## Vercel

Add these variables to Preview and Production environments in the `tajakman/maetajak-copy` project:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_TRADING_WORKER_IP` (실제 고정 Worker IP가 발급된 뒤에만 설정)

The production deployment builds with Vite and publishes `dist`.

## Gate.io verification worker

Gate.io credentials are encrypted in the private Supabase schema. Saving credentials creates a verification job; the browser never receives the stored Key or Secret again.

Run the verification worker on the server whose fixed outbound IP is registered in every member's Gate.io API Whitelist:

```bash
SUPABASE_URL=https://YOUR_PROJECT.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_KEY \
npm run worker:gate
```

Keep `SUPABASE_SERVICE_ROLE_KEY` only in the worker's secret manager. The worker signs a read-only `GET /api/v4/futures/usdt/accounts` request, verifies that the returned Gate user ID matches the submitted UID, and writes only the verification result back to Supabase. Futures write permission and withdrawal disablement remain explicit member confirmations because they cannot be safely proven by placing a test order.

## Copy-trading core

The position-based copy engine and database control plane are documented in [`docs/COPY_ENGINE.md`](docs/COPY_ENGINE.md). The implementation calculates `Master actual position → member target position → member actual position → delta`, detects unexplained position changes as `MANUAL_OVERRIDE`, creates deterministic order idempotency keys, and provides an `UNKNOWN` reconciliation queue.

Live execution is fail-closed: the database starts with execution disabled and emergency halt enabled. The browser cannot enable live orders. Migrations `202608210006_live_worker_runtime.sql` and `202608210007_strict_gate_readiness.sql` add the service-role-only observation, strict Gate permission/IP verification, order, crash-safe reconciliation, heartbeat, and deployment activation functions. See [`docs/WORKER_DEPLOYMENT.md`](docs/WORKER_DEPLOYMENT.md) for the fixed-IP deployment and activation checklist.
