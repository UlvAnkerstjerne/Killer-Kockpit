import 'server-only'
import type { createServiceClient } from '@/lib/supabase/server'

type Db = ReturnType<typeof createServiceClient>

/** Audit event for a Paid Strategy implementation. Never throws, never carries secrets or tokens. */
export async function recordImplementationAudit(
  db: Db, actorId: string, action: 'prepared' | 'executed' | 'started' | 'failed' | 'needs_attention' | 'in_motion' | 'completed' | 'blocked' | 'ready_to_activate' | 'resumed' | 'activated' | 'cancelled',
  implementationId: string, after: Record<string, unknown>, before?: Record<string, unknown>,
) {
  try {
    await db.from('audit_events').insert({
      actor_user_id: actorId, actor_type: 'human', action: `marketing.paid_strategy_implementation.${action}`,
      entity_type: 'paid_strategy_implementation', entity_id: implementationId,
      ...(before ? { before_json: before } : {}), after_json: after,
    })
  } catch (err) {
    console.error('[paid-strategy/implementation] audit insert failed:', (err as Error).message)
  }
}
