'use server'

import { createServiceClient } from './supabase/server'

// Writes an immutable audit event using the service-role client.
// Ordinary users cannot write or alter audit events via RLS.
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
}) {
  const supabase = await createServiceClient()

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
    // Audit failures should be logged but must not silently suppress the
    // underlying operation. Surface the error to server logs.
    console.error('[audit] Failed to record audit event:', error)
  }
}
