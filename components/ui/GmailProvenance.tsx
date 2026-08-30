import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'

type Props = {
  entityType: string
  entityId: string
}

/**
 * Server component that renders Gmail provenance metadata for a task or waiting-on.
 * Renders nothing if no Gmail source is linked to this entity.
 *
 * Queries: entity_sources → sources (where source_type = 'gmail_message')
 * At most one Gmail source per entity is displayed.
 */
export default async function GmailProvenance({ entityType, entityId }: Props) {
  const supabase = await createClient()

  // Single join query: entity_sources → sources
  const { data: links } = await supabase
    .from('entity_sources')
    .select('source:source_id(source_type, title, url, metadata, occurred_at)')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)

  type SourceRow = { source_type: string; title: string; url: string | null; metadata: unknown; occurred_at: string | null }
  const source = (links ?? [])
    .map((l) => l.source as unknown as SourceRow | null)
    .find((s) => s?.source_type === 'gmail_message') ?? null

  if (!source) return null

  const meta = source.metadata as { from?: string } | null
  const from = meta?.from ?? null
  const date = source.occurred_at
    ? new Date(source.occurred_at as string).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    : null

  return (
    <div>
      <div className="text-xs text-kk-muted mb-0.5">Created from email</div>
      {source.url ? (
        <Link
          href={source.url as string}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-kk-ink hover:underline font-medium"
        >
          {source.title as string}
        </Link>
      ) : (
        <div className="text-sm text-kk-ink font-medium">{source.title as string}</div>
      )}
      {from && <div className="text-xs text-kk-muted mt-0.5">From: {from}</div>}
      {date && <div className="text-xs text-kk-muted">{date}</div>}
    </div>
  )
}
