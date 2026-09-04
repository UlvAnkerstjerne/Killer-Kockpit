import Link from 'next/link'
import { createServiceClient } from '@/lib/supabase/server'

type Props = {
  entityType:    string
  entityId:      string
  currentUserId: string
}

/**
 * Server component that renders Gmail provenance metadata for a task or waiting-on.
 * Renders nothing if no Gmail source is linked to this entity.
 *
 * Queries entity_sources → sources via service client (sources/entity_sources
 * have SUPER_ADMIN-only RLS; entity access is already verified by the calling page).
 *
 * Privacy rule: the Gmail deep link (source.url) is shown only when the
 * current viewer is the source owner (source_account_user_id === currentUserId).
 * All other viewers see subject/sender/date as non-clickable text.
 */
export default async function GmailProvenance({ entityType, entityId, currentUserId }: Props) {
  // Service client bypasses SUPER_ADMIN-only RLS on sources/entity_sources.
  // Entity access has already been verified by the calling page (404 handling).
  const serviceClient = createServiceClient()

  const { data: links } = await serviceClient
    .from('entity_sources')
    .select('source:source_id(source_type, title, url, metadata, occurred_at, source_account_user_id)')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)

  type SourceRow = {
    source_type:            string
    title:                  string
    url:                    string | null
    metadata:               unknown
    occurred_at:            string | null
    source_account_user_id: string | null
  }

  const source = (links ?? [])
    .map((l) => l.source as unknown as SourceRow | null)
    .find((s) => s?.source_type === 'gmail_message') ?? null

  if (!source) return null

  const meta   = source.metadata as { from?: string } | null
  const from   = meta?.from ?? null
  const date   = source.occurred_at
    ? new Date(source.occurred_at).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    : null

  // Show clickable Gmail deep link only to the source owner.
  // Non-owners see the same metadata without an actionable link.
  const isOwner   = source.source_account_user_id === currentUserId
  const showLink  = isOwner && !!source.url

  return (
    <div>
      <div className="text-xs text-kk-muted mb-0.5">Created from email</div>
      {showLink ? (
        <Link
          href={source.url as string}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-kk-ink hover:underline font-medium"
        >
          {source.title}
        </Link>
      ) : (
        <div className="text-sm text-kk-ink font-medium">{source.title}</div>
      )}
      {from && <div className="text-xs text-kk-muted mt-0.5">From: {from}</div>}
      {date && <div className="text-xs text-kk-muted">{date}</div>}
    </div>
  )
}
