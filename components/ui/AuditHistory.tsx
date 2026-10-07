import { createClient } from '@/lib/supabase/server'
import { collectReferencedIds, describeAuditEvent, type AuditLookups } from '@/lib/audit/describe'
import { formatCopenhagen } from '@/lib/time'

export default async function AuditHistory({
  entityType,
  entityId,
}: {
  entityType: string
  entityId: string
}) {
  const supabase = await createClient()

  const { data: events, error } = await supabase
    .from('audit_events')
    .select(`
      id, action, actor_type, before_json, after_json, metadata, created_at,
      actor:actor_user_id (id, display_name, email)
    `)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    return (
      <p className="text-sm text-kk-bad">Could not load history.</p>
    )
  }

  if (!events || events.length === 0) {
    return (
      <p className="text-sm text-kk-muted py-4">No history recorded yet.</p>
    )
  }

  // Resolve user / project references through the caller's own RLS-scoped client.
  // Anything not returned (deleted, hidden) renders as "Unknown …" rather than a raw id.
  const { userIds, projectIds } = collectReferencedIds(events)
  const [usersRes, projectsRes] = await Promise.all([
    userIds.length
      ? supabase.from('app_users').select('id, display_name').in('id', userIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
    projectIds.length
      ? supabase.from('projects').select('id, title').in('id', projectIds)
      : Promise.resolve({ data: [] as { id: string; title: string }[] }),
  ])
  const lookups = {
    users: new Map((usersRes.data ?? []).map(u => [u.id, u.display_name] as const)),
    projects: new Map((projectsRes.data ?? []).map(p => [p.id, p.title] as const)),
  }

  return <AuditHistoryList events={events as AuditEventListItem[]} entityType={entityType} lookups={lookups} />
}

export type AuditEventListItem = {
  id: string
  action: string
  before_json: Record<string, unknown> | null
  after_json: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
  created_at: string
  actor?: { display_name?: string | null } | { display_name?: string | null }[] | null
}

/** Presentational list; takes already-resolved lookups so it renders from fixtures. */
export function AuditHistoryList({
  events,
  entityType,
  lookups,
}: {
  events: AuditEventListItem[]
  entityType: string
  lookups: AuditLookups
}) {
  return (
    <div className="space-y-0">
      {events.map((event) => {
        const actor = Array.isArray(event.actor) ? event.actor[0] : event.actor
        const actorName = actor?.display_name || 'System'
        const dateStr = formatCopenhagen(event.created_at, { day: 'numeric', month: 'short' })
        const timeStr = formatCopenhagen(event.created_at, { hour: '2-digit', minute: '2-digit' })
        const { title, lines } = describeAuditEvent(event, entityType, lookups)

        return (
          <div
            key={event.id}
            className="grid grid-cols-[80px_1fr] gap-3 py-3 border-t border-kk-line first:border-t-0"
          >
            <div className="text-xs text-kk-muted pt-0.5">
              <div>{dateStr}</div>
              <div>{timeStr}</div>
            </div>
            <div>
              <div className="text-sm text-kk-ink">{title}</div>
              {lines.map((line, i) => (
                <div key={i} className="text-xs text-kk-muted mt-0.5 break-words">{line}</div>
              ))}
              <div className="text-xs text-kk-muted mt-0.5">{actorName}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
