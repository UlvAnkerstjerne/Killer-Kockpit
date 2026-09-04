export type KKRole = 'SUPER_ADMIN' | 'UM' | 'MEMBER'
export type TodoStatus = 'open' | 'completed' | 'cancelled'
export type ProjectStatus = 'planned' | 'active' | 'at_risk' | 'blocked' | 'completed' | 'archived' | 'cancelled'
export type TaskStatus = 'proposed' | 'open' | 'in_progress' | 'blocked' | 'pending_review' | 'done' | 'cancelled'
export type TaskPriority = 1 | 2 | 3 | 4
export type ViewMode = 'personal' | 'management'
export type WaitingStatus = 'open' | 'fulfilled' | 'overdue' | 'cancelled'
export type DecisionStatus = 'proposed' | 'approved' | 'superseded'

export interface AppUser {
  id: string
  google_subject_id: string | null
  auth_user_id: string | null
  email: string
  display_name: string
  role: KKRole
  active: boolean
  marketing_access: boolean
  timezone: string
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  title: string
  description: string | null
  owner_user_id: string | null
  status: ProjectStatus
  start_date: string | null
  due_date: string | null
  progress: number | null
  parent_project_id: string | null
  archived_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
  owner?: Pick<AppUser, 'id' | 'display_name' | 'email'>
  task_count?: number
}

export interface Task {
  id: string
  project_id: string | null
  title: string
  description: string | null
  owner_user_id: string | null
  status: TaskStatus
  priority: TaskPriority
  due_at: string | null
  completed_at: string | null
  created_by_user_id: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
  // Handoff / review fields (added in migration 032)
  submitted_by_user_id: string | null
  submitted_at: string | null
  approved_by_user_id: string | null
  approved_at: string | null
  returned_by_user_id: string | null
  returned_at: string | null
  latest_review_note: string | null
  owner?: Pick<AppUser, 'id' | 'display_name' | 'email'>
  project?: Pick<Project, 'id' | 'title'>
  creator?: Pick<AppUser, 'id' | 'display_name'>
}

export interface AuditEvent {
  id: string
  actor_user_id: string | null
  actor_type: string
  action: string
  entity_type: string
  entity_id: string | null
  before_json: Record<string, unknown> | null
  after_json: Record<string, unknown> | null
  metadata: Record<string, unknown>
  created_at: string
  actor?: Pick<AppUser, 'id' | 'display_name' | 'email'>
}

export interface WaitingOn {
  id: string
  title: string
  owner_user_id: string | null
  waiting_for_user_id: string | null
  waiting_for_employee_id: string | null
  waiting_for_name: string | null
  project_id: string | null
  due_at: string | null
  fulfilled_at: string | null
  notes: string | null
  priority: TaskPriority
  status: WaitingStatus
  archived_at: string | null
  created_at: string
  updated_at: string
  owner?: Pick<AppUser, 'id' | 'display_name' | 'email'>
  waiting_for_user?: Pick<AppUser, 'id' | 'display_name' | 'email'>
  project?: Pick<Project, 'id' | 'title'>
}

export interface Decision {
  id: string
  title: string
  decision_text: string
  rationale: string | null
  owner_user_id: string | null
  project_id: string | null
  meeting_id: string | null
  decided_at: string | null
  approved_by_user_id: string | null
  status: DecisionStatus
  supersedes_decision_id: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
  owner?: Pick<AppUser, 'id' | 'display_name' | 'email'>
  approved_by?: Pick<AppUser, 'id' | 'display_name' | 'email'>
  project?: Pick<Project, 'id' | 'title'>
}

export type MeetingStatus = 'scheduled' | 'open' | 'draft' | 'published' | 'cancelled'
export type MeetingOutcomeKind = 'task' | 'waiting_on' | 'decision'
export type MeetingOutcomeStatus = 'proposed' | 'published' | 'removed'

export type CalendarSyncStatus = 'synced' | 'failed' | 'pending'

export interface Meeting {
  id: string
  title: string
  owner_user_id: string | null
  project_id: string | null
  calendar_event_id: string | null
  calendar_event_url: string | null
  calendar_sync_status: CalendarSyncStatus | null
  calendar_sync_error: string | null
  calendar_synced_at: string | null
  calendar_synced_by_user_id: string | null
  meet_space_name: string | null
  scheduled_start: string | null
  scheduled_end: string | null
  actual_start: string | null
  actual_end: string | null
  status: MeetingStatus
  context: string | null
  working_notes: string | null
  recording_url: string | null
  minutes_status: string
  created_by_user_id: string | null
  created_at: string
  updated_at: string
  owner?: Pick<AppUser, 'id' | 'display_name' | 'email'>
  project?: Pick<Project, 'id' | 'title'>
}

export interface AgendaItem {
  id: string
  meeting_id: string
  title: string
  description: string | null
  source_kind: string | null
  related_entity_type: string | null
  related_entity_id: string | null
  sort_order: number
  status: string
  created_at: string
}

export interface MeetingAttendee {
  id: string
  meeting_id: string
  user_id: string | null
  external_name: string | null
  external_email: string | null
  user?: Pick<AppUser, 'id' | 'display_name' | 'email'>
}

export interface MeetingOutcome {
  id: string
  meeting_id: string
  kind: MeetingOutcomeKind
  title: string
  payload_json: Record<string, unknown>
  status: MeetingOutcomeStatus
  proposed_by_user_id: string | null
  published_entity_id: string | null
  ai_draft_id: string | null
  sort_order: number
  created_at: string
  updated_at: string
  proposed_by?: Pick<AppUser, 'id' | 'display_name'>
}

export type ChangeRequestStatus = 'pending' | 'approved' | 'rejected'

export interface ChangeRequest {
  id: string
  entity_type: string
  entity_id: string
  requester_id: string
  proposed_changes: Record<string, unknown>
  reason: string | null
  status: ChangeRequestStatus
  reviewed_by_id: string | null
  review_note: string | null
  reviewed_at: string | null
  created_at: string
  updated_at: string
  requester?: Pick<AppUser, 'id' | 'display_name' | 'email'>
  reviewed_by?: Pick<AppUser, 'id' | 'display_name' | 'email'>
}

export interface MeetingAiDraft {
  id: string
  meeting_id: string
  transcript_source_id: string
  model: string
  prompt_version: string
  input_char_count: number
  output_json: import('./ai/meeting-draft-schema').MeetingDraftOutput
  generated_by_user_id: string
  generated_at: string
  applied_at: string | null
  applied_by_user_id: string | null
  discarded_at: string | null
  discarded_by_user_id: string | null
}

export interface MeetingMinutes {
  id: string
  meeting_id: string
  version: number
  body: string
  status: string
  approved_by_user_id: string | null
  approved_at: string | null
  created_at: string
  approver?: { display_name: string } | null
}

export interface ActionResult<T = void> {
  data?: T
  error?: string
}

export interface Todo {
  id: string
  user_id: string
  title: string
  priority: 1 | 2 | 3 | 4
  created_at: string
  updated_at: string
  completed_at: string | null
  cancelled_at: string | null
  notes: string | null
  scheduled_for: string | null
  recurrence_rule: string | null
  recurrence_day: number | null
  parent_todo_id: string | null
}

/** Todo enriched with owner display name — used for the Team visibility view. */
export interface TeamTodo {
  id: string
  user_id: string
  title: string
  priority: 1 | 2 | 3 | 4
  created_at: string
  updated_at: string
  completed_at: string | null
  cancelled_at: string | null
  notes: string | null
  scheduled_for: string | null
  recurrence_rule: string | null
  recurrence_day: number | null
  parent_todo_id: string | null
  owner: { id: string; display_name: string }
}
