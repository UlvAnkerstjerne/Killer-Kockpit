'use server'

import { createServiceClient } from './supabase/server'

// Writes an immutable audit event using the service-role client.
// Ordinary users cannot write or alter audit events via RLS.
// Returns { error } so callers can propagate failures rather than silently
// allowing a mutation to succeed without a corresponding audit record.
export async function recordAuditEvent({
  actorUserId,
  action,
  entityType,
  entityId,
  beforeJson,
  afterJson,
  metadata = {},
}: {
  actorUserId: string | null
  action: string
  entityType: string
  entityId: string
  beforeJson?: Record<string, unknown> | null
  afterJson?: Record<string, unknown> | null
  metadata?: Record<string, unknown>
}): Promise<{ error: unknown }> {
  const supabase = createServiceClient()

  const { error } = await supabase.from('audit_events').insert({
    actor_user_id: actorUserId,
    actor_type: 'human',
    action,
    entity_type: entityType,
    entity_id: entityId,
    before_json: beforeJson ?? null,
    after_json: afterJson ?? null,
    metadata,
  })

  if (error) {
    console.error('[audit] Failed to record audit event:', error)
    return { error }
  }

  return { error: null }
}
