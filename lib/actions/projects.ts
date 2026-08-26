'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { recordAuditEvent } from '@/lib/audit'
import { canEditProject, canArchiveProject } from '@/lib/permissions'
import type { ProjectStatus, ActionResult } from '@/lib/types'

type ProjectInput = {
  title: string
  description?: string
  owner_user_id?: string
  status?: ProjectStatus
  start_date?: string
  due_date?: string
  progress?: number
}

export async function createProject(input: ProjectInput): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('projects')
    .insert({
      title: input.title.trim(),
      description: input.description?.trim() || null,
      owner_user_id: input.owner_user_id || user.id,
      status: input.status || 'planned',
      start_date: input.start_date || null,
      due_date: input.due_date || null,
      progress: input.progress ?? null,
      created_by_user_id: user.id,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[createProject]', error)
    return { error: 'Failed to create project. Please try again.' }
  }

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'project.created',
    entityType: 'project',
    entityId: data.id,
    afterJson: { title: input.title, status: input.status || 'planned', owner_user_id: input.owner_user_id || user.id },
  })

  revalidatePath('/projects')
  revalidatePath('/today')
  return { data: { id: data.id } }
}

export async function updateProject(
  projectId: string,
  input: Partial<ProjectInput> & { status?: ProjectStatus }
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  // Fetch current project to check ownership and compute diff
  const supabase = await createClient()
  const { data: current, error: fetchError } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single()

  if (fetchError || !current) return { error: 'Project not found.' }

  if (!canEditProject(user.role, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to edit this project.' }
  }

  const updates: Record<string, unknown> = {}
  const changedFields: Record<string, { from: unknown; to: unknown }> = {}

  const fields = ['title', 'description', 'owner_user_id', 'status', 'start_date', 'due_date', 'progress'] as const
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
    .from('projects')
    .update(updates)
    .eq('id', projectId)

  if (error) {
    console.error('[updateProject]', error)
    return { error: 'Failed to save changes. Please try again.' }
  }

  // Record one audit event per changed field
  for (const [field, diff] of Object.entries(changedFields)) {
    await recordAuditEvent({
      actorUserId: user.id,
      action: `project.${field}.changed`,
      entityType: 'project',
      entityId: projectId,
      beforeJson: { [field]: diff.from },
      afterJson: { [field]: diff.to },
    })
  }

  revalidatePath('/projects')
  revalidatePath(`/projects/${projectId}`)
  revalidatePath('/today')
  return {}
}

export async function archiveProject(projectId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: current, error: fetchError } = await supabase
    .from('projects')
    .select('id, owner_user_id, status, title')
    .eq('id', projectId)
    .single()

  if (fetchError || !current) return { error: 'Project not found.' }

  if (!canArchiveProject(user.role, current.owner_user_id, user.id)) {
    return { error: 'You do not have permission to archive this project.' }
  }

  const { error } = await supabase
    .from('projects')
    .update({ archived_at: new Date().toISOString(), status: 'archived' })
    .eq('id', projectId)

  if (error) return { error: 'Failed to archive project.' }

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'project.archived',
    entityType: 'project',
    entityId: projectId,
    beforeJson: { status: current.status },
    afterJson: { status: 'archived' },
  })

  revalidatePath('/projects')
  revalidatePath(`/projects/${projectId}`)
  revalidatePath('/today')
  return {}
}
