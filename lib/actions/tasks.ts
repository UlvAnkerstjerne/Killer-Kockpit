'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { recordAuditEvent } from '@/lib/audit'
import { canEditTask } from '@/lib/permissions'
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

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      title: input.title.trim(),
      description: input.description?.trim() || null,
      owner_user_id: input.owner_user_id || user.id,
      project_id: input.project_id || null,
      status: input.status || 'open',
      priority: input.priority || 2,
      due_at: input.due_at || null,
      created_by_user_id: user.id,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[createTask]', error)
    return { error: 'Failed to create task. Please try again.' }
  }

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'task.created',
    entityType: 'task',
    entityId: data.id,
    afterJson: {
      title: input.title,
      status: input.status || 'open',
      owner_user_id: input.owner_user_id || user.id,
      priority: input.priority || 2,
    },
  })

  revalidatePath('/tasks')
  revalidatePath('/today')
  if (input.project_id) revalidatePath(`/projects/${input.project_id}`)
  return { data: { id: data.id } }
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

  if (!canEditTask(user.role, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to edit this task.' }
  }

  const updates: Record<string, unknown> = {}
  const changedFields: Record<string, { from: unknown; to: unknown }> = {}

  const fields = ['title', 'description', 'owner_user_id', 'project_id', 'status', 'priority', 'due_at'] as const
  for (const field of fields) {
    if (input[field as keyof typeof input] !== undefined) {
      const newVal = field === 'title' || field === 'description'
        ? (input[field as keyof typeof input] as string)?.trim() ?? null
        : input[field as keyof typeof input]

      if (newVal !== current[field]) {
        updates[field] = newVal
        changedFields[field] = { from: current[field], to: newVal }
      }
    }
  }

  if (Object.keys(updates).length === 0) return {}

  const { error } = await supabase
    .from('tasks')
    .update(updates)
    .eq('id', taskId)

  if (error) {
    console.error('[updateTask]', error)
    return { error: 'Failed to save changes. Please try again.' }
  }

  for (const [field, diff] of Object.entries(changedFields)) {
    await recordAuditEvent({
      actorUserId: user.id,
      action: `task.${field}.changed`,
      entityType: 'task',
      entityId: taskId,
      beforeJson: { [field]: diff.from },
      afterJson: { [field]: diff.to },
    })
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
    .select('id, owner_user_id, status, project_id')
    .eq('id', taskId)
    .single()

  if (fetchError || !current) return { error: 'Task not found.' }

  if (!canEditTask(user.role, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to complete this task.' }
  }

  const now = new Date().toISOString()
  const { error } = await supabase
    .from('tasks')
    .update({ status: 'done', completed_at: now })
    .eq('id', taskId)

  if (error) return { error: 'Failed to complete task.' }

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'task.completed',
    entityType: 'task',
    entityId: taskId,
    beforeJson: { status: current.status },
    afterJson: { status: 'done', completed_at: now },
  })

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
    .select('id, owner_user_id, status, project_id')
    .eq('id', taskId)
    .single()

  if (fetchError || !current) return { error: 'Task not found.' }

  if (!canEditTask(user.role, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to cancel this task.' }
  }

  const { error } = await supabase
    .from('tasks')
    .update({ status: 'cancelled', archived_at: new Date().toISOString() })
    .eq('id', taskId)

  if (error) return { error: 'Failed to cancel task.' }

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'task.cancelled',
    entityType: 'task',
    entityId: taskId,
    beforeJson: { status: current.status },
    afterJson: { status: 'cancelled' },
  })

  revalidatePath('/tasks')
  revalidatePath('/today')
  if (current.project_id) revalidatePath(`/projects/${current.project_id}`)
  return {}
}
