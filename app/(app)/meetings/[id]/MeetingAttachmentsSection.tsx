'use client'

/**
 * MeetingAttachmentsSection
 *
 * Displays plain-text documents (.txt, .md) attached to a meeting and lets
 * authorised users upload new ones or remove existing ones.
 *
 * These attachments are indexed by the Brain — uploading a document here
 * makes its content available when a Brain question is about this meeting.
 *
 * Accepted formats: .txt, .md  (max 200 KB each)
 */

import { useRef, useState, useTransition } from 'react'
import { attachMeetingDocument, detachMeetingDocument } from '@/lib/actions/meeting-attachments'
import type { MeetingAttachment } from '@/lib/actions/meeting-attachments'

interface Props {
  meetingId:   string
  initialDocs: MeetingAttachment[]
  canManage:   boolean
}

export default function MeetingAttachmentsSection({ meetingId, initialDocs, canManage }: Props) {
  const [docs, setDocs]                 = useState<MeetingAttachment[]>(initialDocs)
  const [uploadError, setUploadError]   = useState<string | null>(null)
  const [deleteError, setDeleteError]   = useState<string | null>(null)
  const [isPending, startTransition]    = useTransition()
  const fileInputRef                    = useRef<HTMLInputElement>(null)

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setUploadError(null)
    setDeleteError(null)

    const formData = new FormData()
    formData.append('file', file)

    startTransition(async () => {
      const result = await attachMeetingDocument(meetingId, formData)
      if (result.error) {
        setUploadError(result.error)
      } else if (result.data) {
        setDocs(prev => [...prev, result.data!])
      }
      // Reset file input so the same file can be re-uploaded after removal
      if (fileInputRef.current) fileInputRef.current.value = ''
    })
  }

  function handleDelete(entitySourceId: string) {
    setDeleteError(null)
    startTransition(async () => {
      const result = await detachMeetingDocument(meetingId, entitySourceId)
      if (result.error) {
        setDeleteError(result.error)
      } else {
        setDocs(prev => prev.filter(d => d.entitySourceId !== entitySourceId))
      }
    })
  }

  const isEmpty = docs.length === 0

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-kk-ink">Attached Documents</h2>
          <p className="text-xs text-kk-muted mt-0.5">Brain-readable — .txt .md .csv .rtf .pdf .docx .pptx .xlsx · max 5 MB</p>
        </div>
        {canManage && (
          <label
            className={`text-xs px-3 py-1.5 rounded-lg font-medium cursor-pointer transition-colors ${
              isPending
                ? 'bg-kk-soft text-kk-muted cursor-not-allowed'
                : 'bg-kk-soft text-kk-ink hover:bg-kk-line'
            }`}
          >
            {isPending ? 'Uploading…' : '+ Add document'}
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.csv,.rtf,.pdf,.docx,.pptx,.xlsx,.xls"
              className="sr-only"
              onChange={handleFileChange}
              disabled={isPending}
            />
          </label>
        )}
      </div>

      <div className="px-5 py-3 space-y-2">
        {isEmpty ? (
          <p className="text-xs text-kk-muted py-1">
            {canManage
              ? 'No documents attached. Upload a document (.txt, .md, .pdf, .docx, .pptx, .xlsx…) to make it available to the Brain.'
              : 'No documents attached.'}
          </p>
        ) : (
          docs.map(doc => (
            <div
              key={doc.entitySourceId}
              className="flex items-start gap-3 py-1.5"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-kk-ink truncate">{doc.fileName}</div>
                {doc.contentPreview && (
                  <div className="text-xs text-kk-muted mt-0.5 line-clamp-2">
                    {doc.contentPreview}
                  </div>
                )}
                <div className="text-xs text-kk-muted mt-0.5">
                  Added {new Date(doc.attachedAt).toLocaleDateString('en-GB', {
                    day: 'numeric', month: 'short', year: 'numeric',
                  })}
                </div>
              </div>
              {canManage && (
                <button
                  onClick={() => handleDelete(doc.entitySourceId)}
                  disabled={isPending}
                  className="shrink-0 text-xs text-kk-muted hover:text-kk-warn transition-colors disabled:opacity-40 pt-0.5"
                  aria-label={`Remove ${doc.fileName}`}
                >
                  Remove
                </button>
              )}
            </div>
          ))
        )}

        {uploadError && (
          <p className="text-xs text-kk-warn pt-1">{uploadError}</p>
        )}
        {deleteError && (
          <p className="text-xs text-kk-warn pt-1">{deleteError}</p>
        )}
      </div>
    </div>
  )
}
