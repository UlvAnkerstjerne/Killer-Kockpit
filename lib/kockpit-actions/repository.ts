import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { insertTaskWithAudit, type NormalizedTaskCreateInput } from '@/lib/domain/task-creation'
import { insertTodoForActor, type NormalizedTodoCreateInput } from '@/lib/domain/todo-creation'
import type { KKRole } from '@/lib/types'

export type KockpitActionsActor = { id: string; email: string; role: KKRole }
export type KockpitActionSource = 'external_api' | 'chatgpt_mcp'

export type ActionRequestRow = {
  id: string
  source: KockpitActionSource
  external_request_id: string
  request_hash: string
  action_type: 'create_task' | 'create_todo'
  actor_user_id: string
  status: 'processing' | 'succeeded' | 'failed'
  result_entity_type: 'task' | 'todo' | null
  result_entity_id: string | null
  error_code: string | null
  error_message: string | null
  error_status: number | null
}

export type ClaimResult =
  | { kind: 'claimed'; row: ActionRequestRow }
  | { kind: 'existing'; row: ActionRequestRow }
  | { kind: 'error' }

export interface KockpitActionsRepository {
  resolveActor(email: string): Promise<KockpitActionsActor | null>
  claim(source: KockpitActionSource, requestId: string, requestHash: string, action: ActionRequestRow['action_type'], actorId: string): Promise<ClaimResult>
  ownerExists(userId: string): Promise<boolean>
  projectExists(projectId: string): Promise<boolean>
  createTask(actorId: string, input: NormalizedTaskCreateInput): Promise<{ id?: string; error?: unknown }>
  createTodo(actorId: string, input: NormalizedTodoCreateInput): Promise<{ id?: string; error?: unknown }>
  markSucceeded(rowId: string, entityType: 'task' | 'todo', entityId: string): Promise<boolean>
  markFailed(rowId: string, code: string, message: string, status: number): Promise<boolean>
}

export function createKockpitActionsRepository(
  client: SupabaseClient = createServiceClient(),
): KockpitActionsRepository {
  return {
    async resolveActor(email) {
      const { data, error } = await client
        .from('app_users')
        .select('id, email, role')
        .eq('email', email)
        .eq('active', true)
        .maybeSingle()
      if (error || !data) return null
      return data as KockpitActionsActor
    },

    async claim(source, requestId, requestHash, action, actorId) {
      const { data, error } = await client
        .from('kockpit_action_requests')
        .insert({
          source,
          external_request_id: requestId,
          request_hash: requestHash,
          action_type: action,
          actor_user_id: actorId,
          status: 'processing',
        })
        .select('*')
        .single()

      if (!error && data) return { kind: 'claimed', row: data as ActionRequestRow }
      if ((error as { code?: string } | null)?.code !== '23505') return { kind: 'error' }

      const { data: existing, error: existingError } = await client
        .from('kockpit_action_requests')
        .select('*')
        .eq('source', source)
        .eq('external_request_id', requestId)
        .maybeSingle()
      if (existingError || !existing) return { kind: 'error' }
      return { kind: 'existing', row: existing as ActionRequestRow }
    },

    async ownerExists(userId) {
      const { data, error } = await client
        .from('app_users')
        .select('id')
        .eq('id', userId)
        .eq('active', true)
        .maybeSingle()
      return !error && Boolean(data)
    },

    async projectExists(projectId) {
      const { data, error } = await client
        .from('projects')
        .select('id')
        .eq('id', projectId)
        .maybeSingle()
      return !error && Boolean(data)
    },

    createTask(actorId, input) {
      return insertTaskWithAudit(client, actorId, input)
    },

    createTodo(actorId, input) {
      return insertTodoForActor(client, actorId, input)
    },

    async markSucceeded(rowId, entityType, entityId) {
      const { error } = await client
        .from('kockpit_action_requests')
        .update({
          status: 'succeeded',
          result_entity_type: entityType,
          result_entity_id: entityId,
          completed_at: new Date().toISOString(),
        })
        .eq('id', rowId)
      return !error
    },

    async markFailed(rowId, code, message, status) {
      const { error } = await client
        .from('kockpit_action_requests')
        .update({
          status: 'failed',
          error_code: code,
          error_message: message,
          error_status: status,
          completed_at: new Date().toISOString(),
        })
        .eq('id', rowId)
      return !error
    },
  }
}
