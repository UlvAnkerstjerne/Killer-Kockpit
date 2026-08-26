export type KKRole = 'SUPER_ADMIN' | 'UM' | 'MEMBER'
export type ProjectStatus = 'planned' | 'active' | 'at_risk' | 'blocked' | 'completed' | 'archived'
export type TaskStatus = 'proposed' | 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
export type TaskPriority = 1 | 2 | 3 | 4
export type ViewMode = 'personal' | 'management'

export interface AppUser {
  id: string
  google_subject_id: string
  auth_user_id: string
  email: string
  display_name: string
  role: KKRole
  active: boolean
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

export interface ActionResult<T = void> {
  data?: T
  error?: string
}
