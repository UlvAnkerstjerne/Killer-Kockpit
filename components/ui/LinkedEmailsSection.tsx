import type { GmailSourceEntry } from '@/lib/actions/gmail'

type Props = {
  sources: GmailSourceEntry[]
}

/**
 * Compact read-only display of Gmail messages linked to an entity.
 * Renders nothing when there are no linked emails.
 *
 * Privacy: gmailUrl is non-null only for the source owner (enforced server-side
 * by getEntityGmailSources). Non-owners see subject/sender/date/captured-by
 * as non-clickable institutional metadata.
 */
export default function LinkedEmailsSection({ sources }: Props) {
  if (!sources.length) return null

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">
          Related emails
          {sources.length > 0 && (
            <span className="text-kk-muted font-normal"> · {sources.length}</span>
          )}
        </h2>
      </div>

      <div className="divide-y divide-kk-line">
        {sources.map((src) => (
          <div key={src.entitySourceId} className="px-5 py-3 space-y-0.5">
            {/* Subject — clickable only for source owner */}
            {src.gmailUrl ? (
              <a
                href={src.gmailUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm font-medium text-kk-ink hover:underline truncate leading-snug"
              >
                {src.subject}
              </a>
            ) : (
              <div className="text-sm font-medium text-kk-ink truncate leading-snug">
                {src.subject}
              </div>
            )}

            {/* Sender */}
            {src.sender && (
              <div className="text-xs text-kk-muted truncate">From: {src.sender}</div>
            )}

            {/* Date + captured-by */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {src.occurredAt && (
                <span className="text-xs text-kk-muted">
                  {new Date(src.occurredAt).toLocaleDateString('en-GB', {
                    day: 'numeric', month: 'short', year: 'numeric',
                  })}
                </span>
              )}
              <span className="text-xs text-kk-muted">
                · Captured by {src.capturedByName}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
