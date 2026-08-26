# Killer Kockpit — Milestone 1

Internal management operating system for Killer Kebab.

## Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project
- Google Cloud project with OAuth 2.0 credentials

## Local setup

### 1. Install dependencies

```bash
npm install
```

### 2. Environment variables

```bash
cp .env.example .env.local
```

Edit `.env.local`:

| Variable | Where to find it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API → anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role key |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` for local dev |

### 3. Run database migrations

In Supabase → SQL Editor, run these files in order:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_rls_policies.sql`

### 4. Configure Google OAuth in Supabase

See the **Google OAuth setup** section below.

### 5. Add the first SUPER_ADMIN user

After your first sign-in attempt, find your auth record in Supabase → Authentication → Users.
Copy your user UUID and Google subject ID (sub), then insert:

```sql
INSERT INTO app_users (auth_user_id, google_subject_id, email, display_name, role, active)
VALUES (
  'YOUR_SUPABASE_AUTH_UUID',
  'YOUR_GOOGLE_SUBJECT_ID',
  'you@killerkebab.com',
  'Your Name',
  'SUPER_ADMIN',
  true
);
```

Your Google subject ID is the `sub` field in `raw_user_meta_data` (Supabase → Authentication → Users → expand user row).

### 6. Start the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Google OAuth setup

1. Go to [Google Cloud Console](https://console.cloud.google.com) and select or create a project.
2. Go to **APIs & Services → OAuth consent screen** — configure as internal if using Google Workspace.
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**.
4. Application type: **Web application**.
5. Authorised redirect URIs — add:
   - `https://YOUR_SUPABASE_REF.supabase.co/auth/v1/callback`
   - `http://localhost:3000/auth/callback` (for local dev)
6. Copy the **Client ID** and **Client Secret**.
7. In Supabase → Authentication → Providers → Google, paste the Client ID and Client Secret, then enable.

---

## Project structure

```
app/
  (app)/           — authenticated app routes (protected by layout)
    today/         — Today dashboard (real data)
    projects/      — Projects list + detail + create/edit
    tasks/         — Tasks list + detail + create/edit
    inbox/         — Placeholder (Milestone 2)
    team/          — Placeholder (Milestone 2)
    people/        — Placeholder (Milestone 3)
    meetings/      — Placeholder (Milestone 3)
    knowledge/     — Placeholder (Milestone 4)
  login/           — Google sign-in page
  auth/callback/   — OAuth callback + access gate
components/
  layout/          — AppShell, CaptureBar, QuickCreateModal, PlaceholderPage
  projects/        — ProjectForm, ArchiveProjectButton
  tasks/           — TaskList, TaskForm, TaskActionButtons
  ui/              — StatusBadge, EmptyState, AuditHistory
lib/
  actions/         — Server actions: projects.ts, tasks.ts
  supabase/        — client.ts, server.ts, middleware.ts
  auth.ts          — getCurrentUser, getActiveUsers
  audit.ts         — recordAuditEvent (service-role write)
  permissions.ts   — Centralised authorisation (single source of truth)
  types.ts         — TypeScript types
supabase/
  migrations/      — SQL schema + RLS policies
```

## Roles

| Role | Access |
|---|---|
| `SUPER_ADMIN` | Full access, user management |
| `UM` | Organisation-wide projects + tasks, management view |
| `MEMBER` | Own projects and tasks only, personal view only |

Role is stored in `app_users.role` and enforced server-side and in database RLS policies. The browser cannot escalate its own role.

## Access gate

A Google account alone does not grant access. The user must:
1. Sign in with Google OAuth
2. Have an active record in `app_users` (inserted manually or by an admin)

Inactive users are denied access and signed out at the OAuth callback.

## Deferred modules (not in Milestone 1)

Inbox, Team, People, Meetings, Knowledge — visible in navigation as placeholders. The schema exists for these modules but their application features and permission models are not yet implemented.
