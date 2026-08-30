'use server'

import { revalidatePath } from 'next/cache'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canEditProject, canArchiveProject, isAdminOverride } from '@/lib/permissions'
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

  const serviceClient = createServiceClient()

  const { data: projectId, error } = await serviceClient.rpc('create_project_and_audit', {
    p_title: input.title.trim(),
    p_description: input.description?.trim() || null,
    p_owner_user_id: input.owner_user_id || user.id,
    p_status: input.status || 'planned',
    p_start_date: input.start_date || null,
    p_due_date: input.due_date || null,
    p_progress: input.progress ?? null,
    p_created_by_user_id: user.id,
    p_actor_user_id: user.id,
  })

  if (error) {
    console.error('[createProject]', error)
    return { error: 'Failed to create project. Please try again.' }
  }

  revalidatePath('/projects')
  revalidatePath('/today')
  return { data: { id: projectId as string } }
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

  const patch: Record<string, unknown> = {}
  const before: Record<string, unknown> = {}

  const fields = ['title', 'description', 'owner_user_id', 'status', 'start_date', 'due_date', 'progress'] as const
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

  const adminOverride = isAdminOverride(user.role, current.owner_user_id, user.id)
  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc(
    adminOverride ? 'update_project_and_audit_as_admin' : 'update_project_and_audit',
    {
      p_project_id:    projectId,
      p_actor_user_id: user.id,
      p_patch:         patch,
      p_before:        before,
      ...(adminOverride ? { p_override_note: 'Administrative override of project' } : {}),
    }
  )

  if (error) {
    console.error('[updateProject]', error)
    return { error: 'Failed to save changes. Please try again.' }
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

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('archive_project_and_audit', {
    p_project_id: projectId,
    p_actor_user_id: user.id,
    p_before_status: current.status,
  })

  if (error) return { error: 'Failed to archive project.' }

  revalidatePath('/projects')
  revalidatePath(`/projects/${projectId}`)
  revalidatePath('/today')
  return {}
}
