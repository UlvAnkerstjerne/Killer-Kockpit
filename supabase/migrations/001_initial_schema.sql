-- Killer Kockpit -- Milestone 1 initial schema
--
-- app_users.auth_user_id stores the Supabase auth.users UUID, enabling
-- clean RLS policies without repeated auth metadata lookups.
--
-- Table order is intentional: every foreign key references a table that was
-- already created earlier in this file. No ALTER TABLE statements are used
-- for cross-table foreign keys -- everything is declared inline.

create extension if not exists pgcrypto;

-- ---- Enum types -------------------------------------------------------------

create type kk_role as enum ('SUPER_ADMIN', 'UM', 'MEMBER');
create type project_status as enum ('planned', 'active', 'at_risk', 'blocked', 'completed', 'archived');
create type task_status as enum ('proposed', 'open', 'in_progress', 'blocked', 'done', 'cancelled');
create type waiting_status as enum ('open', 'fulfilled', 'overdue', 'cancelled');
create type decision_status as enum ('proposed', 'approved', 'superseded');
create type proposal_status as enum ('pending', 'approved', 'edited', 'rejected');
create type proposal_type as enum ('task', 'decision', 'waiting_on', 'people_entry', 'meeting_minutes', 'agenda_item', 'follow_up', 'draft_reply');
create type source_type as enum ('gmail_message', 'gmail_thread', 'calendar_event', 'drive_file', 'meeting_transcript', 'meeting_recording', 'manual_note', 'manual_entry');
create type people_entry_type as enum ('observation', 'manager_report', 'employee_statement', 'coaching', 'positive_feedback', 'concern', 'management_decision', 'formal_action', 'follow_up');

-- ---- Users ------------------------------------------------------------------

create table app_users (
  id                uuid primary key default gen_random_uuid(),
  -- auth_user_id links to Supabase auth.users.id -- used in RLS policies.
  auth_user_id      uuid unique references auth.users(id) on delete set null,
  google_subject_id text unique not null,
  email             text unique not null,
  display_name      text not null,
  role              kk_role not null default 'MEMBER',
  active            boolean not null default true,
  timezone          text not null default 'Europe/Copenhagen',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---- Employees (deferred -- schema exists but locked down) ------------------

create table employees (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  store_or_team        text,
  role_title           text,
  employment_status    text not null default 'active',
  manager_employee_id  uuid references employees(id),
  linked_user_id       uuid unique references app_users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ---- Projects ---------------------------------------------------------------

create table projects (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null,
  description         text,
  owner_user_id       uuid references app_users(id),
  status              project_status not null default 'planned',
  start_date          date,
  due_date            date,
  progress            smallint check (progress between 0 and 100),
  parent_project_id   uuid references projects(id),
  archived_at         timestamptz,
  created_by_user_id  uuid references app_users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---- Tasks ------------------------------------------------------------------

create table tasks (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid references projects(id),
  title               text not null,
  description         text,
  owner_user_id       uuid references app_users(id),
  status              task_status not null default 'open',
  priority            smallint not null default 2 check (priority between 1 and 4),
  due_at              timestamptz,
  completed_at        timestamptz,
  created_by_user_id  uuid references app_users(id),
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---- Sources (deferred -- locked down) -------------------------------------
-- Created before meetings so that meetings.transcript_source_id can
-- reference it with an inline foreign key constraint.

create table sources (
  id            uuid primary key default gen_random_uuid(),
  source_type   source_type not null,
  external_id   text,
  title         text,
  url           text,
  occurred_at   timestamptz,
  metadata      jsonb not null default '{}'::jsonb,
  content_hash  text,
  created_at    timestamptz not null default now(),
  unique (source_type, external_id)
);

-- ---- Meetings (deferred -- locked down) ------------------------------------
-- transcript_source_id is an FK to sources, declared inline now that
-- sources already exists above.

create table meetings (
  id                   uuid primary key default gen_random_uuid(),
  title                text not null,
  calendar_event_id    text,
  scheduled_start      timestamptz,
  scheduled_end        timestamptz,
  actual_start         timestamptz,
  actual_end           timestamptz,
  status               text not null default 'scheduled',
  recording_url        text,
  transcript_source_id uuid references sources(id),
  minutes_status       text not null default 'none',
  created_by_user_id   uuid references app_users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table meeting_attendees (
  meeting_id     uuid not null references meetings(id) on delete cascade,
  user_id        uuid not null references app_users(id),
  external_name  text,
  external_email text,
  primary key (meeting_id, user_id)
);

create table agenda_items (
  id                   uuid primary key default gen_random_uuid(),
  meeting_id           uuid not null references meetings(id) on delete cascade,
  title                text not null,
  description          text,
  source_kind          text,
  related_entity_type  text,
  related_entity_id    uuid,
  sort_order           integer not null default 0,
  status               text not null default 'open',
  created_at           timestamptz not null default now()
);

create table meeting_minutes (
  id                  uuid primary key default gen_random_uuid(),
  meeting_id          uuid not null references meetings(id) on delete cascade,
  version             integer not null default 1,
  body                text not null,
  status              text not null default 'draft',
  approved_by_user_id uuid references app_users(id),
  approved_at         timestamptz,
  created_at          timestamptz not null default now(),
  unique (meeting_id, version)
);

-- ---- Waiting Ons (deferred -- locked down) ----------------------------------

create table waiting_ons (
  id                      uuid primary key default gen_random_uuid(),
  title                   text not null,
  owner_user_id           uuid references app_users(id),
  waiting_for_user_id     uuid references app_users(id),
  waiting_for_employee_id uuid references employees(id),
  waiting_for_name        text,
  project_id              uuid references projects(id),
  due_at                  timestamptz,
  status                  waiting_status not null default 'open',
  archived_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ---- Decisions (deferred -- locked down) ------------------------------------

create table decisions (
  id                     uuid primary key default gen_random_uuid(),
  title                  text not null,
  decision_text          text not null,
  project_id             uuid references projects(id),
  meeting_id             uuid references meetings(id),
  decided_at             timestamptz,
  approved_by_user_id    uuid references app_users(id),
  status                 decision_status not null default 'proposed',
  supersedes_decision_id uuid references decisions(id),
  archived_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- ---- People Memory (deferred -- locked down) --------------------------------

create table people_entries (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references employees(id),
  entry_type          people_entry_type not null,
  factual_summary     text not null,
  occurred_at         timestamptz,
  reported_by_user_id uuid references app_users(id),
  status              proposal_status not null default 'pending',
  sensitivity_level   smallint not null default 1,
  approved_by_user_id uuid references app_users(id),
  approved_at         timestamptz,
  follow_up_due_at    timestamptz,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---- Notes (deferred -- locked down) ----------------------------------------

create table notes (
  id                  uuid primary key default gen_random_uuid(),
  title               text,
  body                text not null,
  created_by_user_id  uuid references app_users(id),
  related_entity_type text,
  related_entity_id   uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---- Entity Sources (deferred -- locked down) -------------------------------

create table entity_sources (
  id          uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id   uuid not null,
  source_id   uuid not null references sources(id) on delete cascade,
  relation    text not null default 'supports',
  created_at  timestamptz not null default now(),
  unique (entity_type, entity_id, source_id, relation)
);

-- ---- Proposals (deferred -- locked down) ------------------------------------

create table proposals (
  id                    uuid primary key default gen_random_uuid(),
  proposal_type         proposal_type not null,
  payload_json          jsonb not null,
  generated_by_provider text,
  model                 text,
  confidence            numeric(4, 3),
  status                proposal_status not null default 'pending',
  approved_by_user_id   uuid references app_users(id),
  approved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table proposal_sources (
  proposal_id uuid not null references proposals(id) on delete cascade,
  source_id   uuid not null references sources(id) on delete cascade,
  primary key (proposal_id, source_id)
);

-- ---- Audit Events -----------------------------------------------------------

create table audit_events (
  id            uuid primary key default gen_random_uuid(),
  actor_user_id uuid references app_users(id),
  actor_type    text not null default 'human',
  action        text not null,
  entity_type   text not null,
  entity_id     uuid,
  before_json   jsonb,
  after_json    jsonb,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
  -- No updated_at -- audit events are immutable.
);

-- ---- Integration sync state -------------------------------------------------

create table integration_sync_state (
  id               uuid primary key default gen_random_uuid(),
  integration      text not null,
  user_id          uuid references app_users(id),
  cursor           text,
  last_success_at  timestamptz,
  last_attempt_at  timestamptz,
  last_error       text,
  status           text not null default 'not_started',
  unique (integration, user_id)
);

-- ---- Indexes ----------------------------------------------------------------

create index tasks_owner_status_idx      on tasks(owner_user_id, status);
create index tasks_project_idx           on tasks(project_id);
create index tasks_due_at_idx            on tasks(due_at) where due_at is not null;
create index tasks_archived_idx          on tasks(archived_at) where archived_at is null;
create index projects_owner_status_idx   on projects(owner_user_id, status);
create index projects_archived_idx       on projects(archived_at) where archived_at is null;
create index waiting_owner_status_idx    on waiting_ons(owner_user_id, status);
create index people_entries_employee_idx on people_entries(employee_id, occurred_at desc);
create index decisions_project_idx       on decisions(project_id, decided_at desc);
create index meetings_start_idx          on meetings(scheduled_start);
create index audit_entity_idx            on audit_events(entity_type, entity_id, created_at desc);
create index audit_actor_idx             on audit_events(actor_user_id, created_at desc);
create index sources_external_idx        on sources(source_type, external_id);
create index app_users_auth_id_idx       on app_users(auth_user_id);

-- ---- Auto-update updated_at -------------------------------------------------

create or replace function update_updated_at_column()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger app_users_updated_at      before update on app_users      for each row execute function update_updated_at_column();
create trigger projects_updated_at       before update on projects       for each row execute function update_updated_at_column();
create trigger tasks_updated_at          before update on tasks          for each row execute function update_updated_at_column();
create trigger meetings_updated_at       before update on meetings       for each row execute function update_updated_at_column();
create trigger decisions_updated_at      before update on decisions      for each row execute function update_updated_at_column();
create trigger waiting_ons_updated_at    before update on waiting_ons    for each row execute function update_updated_at_column();
create trigger employees_updated_at      before update on employees      for each row execute function update_updated_at_column();
create trigger notes_updated_at          before update on notes          for each row execute function update_updated_at_column();
create trigger proposals_updated_at      before update on proposals      for each row execute function update_updated_at_column();
create trigger people_entries_updated_at before update on people_entries for each row execute function update_updated_at_column();
