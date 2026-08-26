-- Killer Kockpit — Row Level Security policies
--
-- Security model for Milestone 1:
--   SUPER_ADMIN  full read/write everywhere
--   UM           full read/write on projects, tasks, audit; no admin functions
--   MEMBER       own projects + own tasks only; no management view
--
-- Deferred tables (people_entries, employees, meetings, decisions,
-- waiting_ons, notes, sources, proposals) are locked to SUPER_ADMIN only
-- until their permission model is explicitly implemented in a later milestone.

-- ─── Helper: get current app_user ────────────────────────────────────────────

-- Returns the app_users row for the currently authenticated Supabase user.
-- security definer so it can read app_users regardless of RLS on that table.
create or replace function get_my_app_user_id()
returns uuid
language sql
security definer
stable
as $$
  select id from app_users
  where auth_user_id = auth.uid()
  and active = true
  limit 1;
$$;

create or replace function get_my_role()
returns kk_role
language sql
security definer
stable
as $$
  select role from app_users
  where auth_user_id = auth.uid()
  and active = true
  limit 1;
$$;

-- ─── app_users ───────────────────────────────────────────────────────────────

alter table app_users enable row level security;

-- Any authenticated active user can read the user list (needed for owner dropdowns).
create policy "app_users: authenticated users can read"
  on app_users for select
  to authenticated
  using (true);

-- Only SUPER_ADMIN can insert new users. Normal provisioning goes through
-- the OAuth callback which uses the service role.
create policy "app_users: SUPER_ADMIN can insert"
  on app_users for insert
  to authenticated
  with check (get_my_role() = 'SUPER_ADMIN');

-- Only SUPER_ADMIN can update users (includes changing roles).
-- Never trust role changes from the browser — server actions use service role.
create policy "app_users: SUPER_ADMIN can update"
  on app_users for update
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

-- ─── projects ────────────────────────────────────────────────────────────────

alter table projects enable row level security;

-- SUPER_ADMIN and UM: see all non-archived projects.
create policy "projects: management can read all"
  on projects for select
  to authenticated
  using (
    get_my_role() in ('SUPER_ADMIN', 'UM')
    and archived_at is null
  );

-- MEMBER: can only see their own projects.
create policy "projects: member can read own"
  on projects for select
  to authenticated
  using (
    get_my_role() = 'MEMBER'
    and owner_user_id = get_my_app_user_id()
    and archived_at is null
  );

-- Archived projects: management can still see them for audit purposes.
create policy "projects: management can read archived"
  on projects for select
  to authenticated
  using (
    get_my_role() in ('SUPER_ADMIN', 'UM')
    and archived_at is not null
  );

-- Any authenticated active user can create a project.
create policy "projects: authenticated can insert"
  on projects for insert
  to authenticated
  with check (
    get_my_app_user_id() is not null
  );

-- SUPER_ADMIN and UM can update any project.
create policy "projects: management can update any"
  on projects for update
  to authenticated
  using (get_my_role() in ('SUPER_ADMIN', 'UM'));

-- MEMBER can only update projects they own.
create policy "projects: member can update own"
  on projects for update
  to authenticated
  using (
    get_my_role() = 'MEMBER'
    and owner_user_id = get_my_app_user_id()
  );

-- No hard deletes — archiving is done via update (archived_at).

-- ─── tasks ───────────────────────────────────────────────────────────────────

alter table tasks enable row level security;

-- SUPER_ADMIN and UM: see all non-archived tasks.
create policy "tasks: management can read all"
  on tasks for select
  to authenticated
  using (
    get_my_role() in ('SUPER_ADMIN', 'UM')
    and archived_at is null
  );

-- MEMBER: can see tasks they own or created.
create policy "tasks: member can read own"
  on tasks for select
  to authenticated
  using (
    get_my_role() = 'MEMBER'
    and (
      owner_user_id = get_my_app_user_id()
      or created_by_user_id = get_my_app_user_id()
    )
    and archived_at is null
  );

-- Management can read archived tasks.
create policy "tasks: management can read archived"
  on tasks for select
  to authenticated
  using (
    get_my_role() in ('SUPER_ADMIN', 'UM')
    and archived_at is not null
  );

-- Any authenticated active user can create tasks.
create policy "tasks: authenticated can insert"
  on tasks for insert
  to authenticated
  with check (
    get_my_app_user_id() is not null
  );

-- SUPER_ADMIN and UM can update any task.
create policy "tasks: management can update any"
  on tasks for update
  to authenticated
  using (get_my_role() in ('SUPER_ADMIN', 'UM'));

-- MEMBER can only update tasks they own.
create policy "tasks: member can update own"
  on tasks for update
  to authenticated
  using (
    get_my_role() = 'MEMBER'
    and owner_user_id = get_my_app_user_id()
  );

-- ─── audit_events ────────────────────────────────────────────────────────────

alter table audit_events enable row level security;

-- All authenticated active users can read audit events.
create policy "audit_events: authenticated can read"
  on audit_events for select
  to authenticated
  using (get_my_app_user_id() is not null);

-- No insert/update/delete via RLS — audit events are written exclusively
-- via the service-role client from server actions.

-- ─── Deferred tables — locked to SUPER_ADMIN only ───────────────────────────
-- These tables exist in the schema for future milestones.
-- Until their permission model is explicitly implemented, only SUPER_ADMIN
-- can access them. This prevents accidental data exposure.

alter table employees enable row level security;
create policy "employees: SUPER_ADMIN only"
  on employees for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

alter table people_entries enable row level security;
create policy "people_entries: SUPER_ADMIN only"
  on people_entries for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

alter table meetings enable row level security;
create policy "meetings: SUPER_ADMIN only"
  on meetings for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

alter table meeting_attendees enable row level security;
create policy "meeting_attendees: SUPER_ADMIN only"
  on meeting_attendees for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

alter table agenda_items enable row level security;
create policy "agenda_items: SUPER_ADMIN only"
  on agenda_items for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

alter table meeting_minutes enable row level security;
create policy "meeting_minutes: SUPER_ADMIN only"
  on meeting_minutes for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

alter table waiting_ons enable row level security;
create policy "waiting_ons: SUPER_ADMIN only"
  on waiting_ons for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

alter table decisions enable row level security;
create policy "decisions: SUPER_ADMIN only"
  on decisions for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

alter table notes enable row level security;
create policy "notes: SUPER_ADMIN only"
  on notes for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

alter table sources enable row level security;
create policy "sources: SUPER_ADMIN only"
  on sources for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

alter table entity_sources enable row level security;
create policy "entity_sources: SUPER_ADMIN only"
  on entity_sources for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

alter table proposals enable row level security;
create policy "proposals: SUPER_ADMIN only"
  on proposals for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

alter table proposal_sources enable row level security;
create policy "proposal_sources: SUPER_ADMIN only"
  on proposal_sources for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');

alter table integration_sync_state enable row level security;
create policy "integration_sync_state: SUPER_ADMIN only"
  on integration_sync_state for all
  to authenticated
  using (get_my_role() = 'SUPER_ADMIN');
