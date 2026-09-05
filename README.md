# Killer Kockpit — M7

Internal management operating system for Killer Kebab.

**Production:** kockpit.killerkebab.com

## Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project
- Google Cloud project with OAuth 2.0 credentials (Gmail + Google Drive scopes for inbox integration)

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
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3001` for local dev |

### 3. Run database migrations

In Supabase → SQL Editor, run the files in `supabase/migrations/` in order (37 files, `000_` through `036_`).

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

Open [http://localhost:3001](http://localhost:3001).

---

## Google OAuth setup

1. Go to [Google Cloud Console](https://console.cloud.google.com) and select or create a project.
2. Go to **APIs & Services → OAuth consent screen** — configure as internal if using Google Workspace.
3. Enable: Gmail API, Google Drive API.
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**.
5. Application type: **Web application**.
6. Authorised redirect URIs — add:
   - `https://YOUR_SUPABASE_REF.supabase.co/auth/v1/callback`
   - `http://localhost:3001/auth/callback` (for local dev)
7. Copy the **Client ID** and **Client Secret**.
8. In Supabase → Authentication → Providers → Google, paste the Client ID and Client Secret, then enable.

---

## Roles

| Role | Access |
|---|---|
| `SUPER_ADMIN` | Full access, user management |
| `ADMIN` | Organisation-wide access, management view |
| `MEMBER` | Own data only, personal view |

Role is stored in `app_users.role` and enforced server-side in every server action and in database RLS policies. The browser cannot escalate its own role.

## Access gate

A Google account alone does not grant access. The user must:
1. Sign in with Google OAuth
2. Have an active record in `app_users` (inserted by an admin)

Inactive users are denied access and signed out at the OAuth callback.

## Features (as of M7)

- **Today** — daily dashboard: urgent tasks, waiting-ons, to-dos due today, morning brief
- **To-dos** — personal to-dos with recurrence, priority, notes, scheduling
- **Tasks** — cross-user task handoff with accountability tracking
- **Waiting-ons** — track external dependencies
- **Decisions** — log and reference key decisions
- **Meetings** — full lifecycle (scheduled → open → draft → published), agenda, AI-assisted draft minutes, canonical published minutes, transcript ingestion, Gmail/Drive provenance
- **Inbox** — Gmail thread viewer with entity linking (Projects, Meetings, People, Locations)
- **People** — contact directory with Gmail/Drive provenance
- **Locations** — location directory with Gmail/Drive provenance
- **Projects** — project management
- **Team** — user management (SUPER_ADMIN only)
- **Knowledge** — placeholder (not yet built)
