import { createClient } from '@/lib/supabase/server'

function formatAction(action: string): string {
  const map: Record<string, string> = {
    'project.created': 'Project created',
    'project.title.changed': 'Title changed',
    'project.description.changed': 'Description changed',
    'project.status.changed': 'Status changed',
    'project.owner_user_id.changed': 'Owner changed',
    'project.due_date.changed': 'Due date changed',
    'project.progress.changed': 'Progress updated',
    'project.archived': 'Project archived',
    'task.created': 'Task created',
    'task.title.changed': 'Title changed',
    'task.description.changed': 'Description changed',
    'task.status.changed': 'Status changed',
    'task.owner_user_id.changed': 'Owner changed',
    'task.due_at.changed': 'Due date changed',
    'task.priority.changed': 'Priority changed',
    'task.completed': 'Task completed',
    'task.cancelled': 'Task cancelled',
  }
  return map[action] || action
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '—'
  if (typeof val === 'boolean') return val ? 'Yes' : 'No'
  if (typeof val === 'string') {
    // Try to parse as date
    const d = new Date(val)
    if (!isNaN(d.getTime()) && val.includes('T')) {
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    }
    return val
  }
  return String(val)
}

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
      id, action, actor_type, before_json, after_json, created_at,
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

  return (
    <div className="space-y-0">
      {events.map((event) => {
        const actor = Array.isArray(event.actor) ? event.actor[0] : event.actor
        const actorName = actor?.display_name || 'System'
        const date = new Date(event.created_at)
        const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        const timeStr = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

        // Extract the changed value for display
        const beforeVal = event.before_json ? Object.values(event.before_json)[0] : null
        const afterVal = event.after_json ? Object.values(event.after_json)[0] : null

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
              <div className="text-sm text-kk-ink">{formatAction(event.action)}</div>
              {beforeVal !== null && afterVal !== null && (
                <div className="text-xs text-kk-muted mt-0.5">
                  {formatValue(beforeVal)} → {formatValue(afterVal)}
                </div>
              )}
              {beforeVal === null && afterVal !== null && (
                <div className="text-xs text-kk-muted mt-0.5">
                  {formatValue(afterVal)}
                </div>
              )}
              <div className="text-xs text-kk-muted mt-0.5">{actorName}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
