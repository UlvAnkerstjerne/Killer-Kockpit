'use server'

import { revalidatePath } from 'next/cache'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import {
  canEditTaskTerms,
  canUpdateTaskStatus,
  isAdminOverride,
} from '@/lib/permissions'
import type { TaskStatus, TaskPriority, ActionResult } from '@/lib/types'

type TaskInput = {
  title: string
  description?: string
  owner_user_id?: string
  project_id?: string
  status?: TaskStatus
  priority?: TaskPriority
  due_at?: string
}

export async function createTask(input: TaskInput): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const serviceClient = createServiceClient()

  const { data: taskId, error } = await serviceClient.rpc('create_task_and_audit', {
    p_title: input.title.trim(),
    p_description: input.description?.trim() || null,
    p_owner_user_id: input.owner_user_id || user.id,
    p_project_id: input.project_id || null,
    p_status: input.status || 'open',
    p_priority: input.priority || 2,
    p_due_at: input.due_at || null,
    p_created_by_user_id: user.id,
    p_actor_user_id: user.id,
  })

  if (error) {
    console.error('[createTask]', error)
    return { error: 'Failed to create task. Please try again.' }
  }

  revalidatePath('/tasks')
  revalidatePath('/today')
  if (input.project_id) revalidatePath(`/projects/${input.project_id}`)
  return { data: { id: taskId as string } }
}

export async function updateTask(
  taskId: string,
  input: Partial<TaskInput>
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: current, error: fetchError } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .single()

  if (fetchError || !current) return { error: 'Task not found.' }

  // Only the creator (or SUPER_ADMIN) may change commitment terms.
  if (!canEditTaskTerms(user.role, current.created_by_user_id, user.id)) {
    return { error: 'You do not have permission to edit this task.' }
  }

  const patch: Record<string, unknown> = {}
  const before: Record<string, unknown> = {}

  const fields = ['title', 'description', 'owner_user_id', 'project_id', 'status', 'priority', 'due_at'] as const
  for (const field of fields) {
    if (input[field as keyof typeof input] !== undefined) {
      const newVal = field === 'title' || field === 'description'
        ? (input[field as keyof typeof input] as string)?.trim() ?? null
        : input[field as keyof typeof input]

      if (newVal !== current[field]) {
        patch[field] = newVal
        before[field] = current[field]
      }
    }
  }

  if (Object.keys(patch).length === 0) return {}

  const adminOverride = isAdminOverride(user.role, current.created_by_user_id, user.id)
  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc(
    adminOverride ? 'update_task_and_audit_as_admin' : 'update_task_and_audit',
    {
      p_task_id:       taskId,
      p_actor_user_id: user.id,
      p_patch:         patch,
      p_before:        before,
      ...(adminOverride ? { p_override_note: 'Administrative override of task commitment terms' } : {}),
    }
  )

  if (error) {
    console.error('[updateTask]', error)
    return { error: 'Failed to save changes. Please try again.' }
  }

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${taskId}`)
  revalidatePath('/today')
  if (current.project_id) revalidatePath(`/projects/${current.project_id}`)
  return {}
}

export async function completeTask(taskId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: current, error: fetchError } = await supabase
    .from('tasks')
    .select('id, owner_user_id, created_by_user_id, status, project_id')
    .eq('id', taskId)
    .single()

  if (fetchError || !current) return { error: 'Task not found.' }

  // Creator or assignee may complete a task.
  if (!canUpdateTaskStatus(user.role, current.created_by_user_id, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to complete this task.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('complete_task_and_audit', {
    p_task_id: taskId,
    p_actor_user_id: user.id,
    p_before_status: current.status,
    p_now: new Date().toISOString(),
  })

  if (error) return { error: 'Failed to complete task.' }

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${taskId}`)
  revalidatePath('/today')
  if (current.project_id) revalidatePath(`/projects/${current.project_id}`)
  return {}
}

export async function cancelTask(taskId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: current, error: fetchError } = await supabase
    .from('tasks')
    .select('id, owner_user_id, created_by_user_id, status, project_id')
    .eq('id', taskId)
    .single()

  if (fetchError || !current) return { error: 'Task not found.' }

  // Creator or assignee may cancel a task.
  if (!canUpdateTaskStatus(user.role, current.created_by_user_id, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to cancel this task.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('cancel_task_and_audit', {
    p_task_id: taskId,
    p_actor_user_id: user.id,
    p_before_status: current.status,
    p_now: new Date().toISOString(),
  })

  if (error) return { error: 'Failed to cancel task.' }

  revalidatePath('/tasks')
  revalidatePath('/today')
  if (current.project_id) revalidatePath(`/projects/${current.project_id}`)
  return {}
}

export async function reopenTask(taskId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: current, error: fetchError } = await supabase
    .from('tasks')
    .select('id, owner_user_id, created_by_user_id, status, project_id')
    .eq('id', taskId)
    .single()

  if (fetchError || !current) return { error: 'Task not found.' }

  if (!canUpdateTaskStatus(user.role, current.created_by_user_id, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to reopen this task.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('reopen_task_and_audit', {
    p_task_id: taskId,
    p_actor_user_id: user.id,
    p_before_status: current.status,
  })

  if (error) return { error: 'Failed to reopen task.' }

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${taskId}`)
  revalidatePath('/today')
  if (current.project_id) revalidatePath(`/projects/${current.project_id}`)
  return {}
}
