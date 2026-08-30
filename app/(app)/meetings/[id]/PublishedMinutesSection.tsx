/**
 * PublishedMinutesSection
 *
 * Read-only display of the canonical meeting_minutes record.
 *
 * This is a server component — it receives the already-fetched minutes data
 * from the parent page. There is deliberately:
 *   - no edit button
 *   - no save action
 *   - no mutation path
 *
 * Published minutes are an immutable institutional record.
 * Amendments are handled through CorrectionsSection below this component.
 */

import { MarkdownMeetingMinutes } from '@/components/ui/MarkdownMeetingMinutes'

type Props = {
  body: string
  approvedAt: string | null
  approverName: string | null
}

export default function PublishedMinutesSection({ body, approvedAt, approverName }: Props) {
  const publishedLabel = approvedAt
    ? new Date(approvedAt).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="flex items-start justify-between px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">Published Minutes</h2>
        {publishedLabel && (
          <div className="text-xs text-kk-muted text-right">
            {approverName && <span>Published by {approverName}<br /></span>}
            {publishedLabel}
          </div>
        )}
      </div>

      <div className="px-5 py-4">
        {body.trim() ? (
          <MarkdownMeetingMinutes body={body} />
        ) : (
          <p className="text-sm text-kk-muted italic">
            No minutes were recorded for this meeting.
          </p>
        )}
      </div>
    </div>
  )
}
