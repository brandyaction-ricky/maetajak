# maetajak

Private Gate.io copy-trading platform UI. The current application uses Supabase Auth and a server-enforced approval profile before granting access to member or administrator screens.

## Local setup

1. Create a Supabase project.
2. Run `supabase/migrations/202608200001_auth_profiles.sql` in the Supabase SQL Editor.
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

The production deployment builds with Vite and publishes `dist`.
