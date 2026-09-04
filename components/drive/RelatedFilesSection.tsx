'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { attachDriveFile, detachDriveFile } from '@/lib/actions/drive'
import type { DriveFileSource } from '@/lib/actions/drive'

// Defined inline to avoid importing googleapis in the client bundle.
// This file is 'use client' — lib/google/drive.ts uses Node-only googleapis.
function getDriveFileTypeLabel(mimeType: string): string {
  const labels: Record<string, string> = {
    'application/vnd.google-apps.document':     'Docs',
    'application/vnd.google-apps.spreadsheet':  'Sheets',
    'application/vnd.google-apps.presentation': 'Slides',
    'application/vnd.google-apps.form':         'Forms',
    'application/pdf':                          'PDF',
  }
  return labels[mimeType] ?? 'File'
}

type Props = {
  entityType:   'project' | 'meeting' | 'task'
  entityId:     string
  initialFiles: DriveFileSource[]
  canManage:    boolean
  driveEnabled: boolean
}

export default function RelatedFilesSection({
  entityType,
  entityId,
  initialFiles,
  canManage,
  driveEnabled,
}: Props) {
  const router    = useRouter()
  const [url, setUrl]         = useState('')
  const [attaching, setAttaching] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [error, setError]     = useState<string | null>(null)

  async function handleAttach(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim()) return
    setAttaching(true)
    setError(null)
    const result = await attachDriveFile(entityType, entityId, url.trim())
    if (result.error) {
      setError(result.error)
    } else {
      setUrl('')
      router.refresh()
    }
    setAttaching(false)
  }

  async function handleDetach(entitySourceId: string) {
    setRemovingId(entitySourceId)
    setError(null)
    const result = await detachDriveFile(entityType, entityId, entitySourceId)
    if (result.error) {
      setError(result.error)
    } else {
      router.refresh()
    }
    setRemovingId(null)
  }

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">
          Related Files
          {initialFiles.length > 0 && (
            <span className="text-kk-muted font-normal"> · {initialFiles.length}</span>
          )}
        </h2>
      </div>

      <div className="px-5 py-4 space-y-3">
        {/* File list */}
        {initialFiles.length > 0 && (
          <ul className="space-y-2">
            {initialFiles.map((file) => (
              <li key={file.entitySourceId} className="flex items-start gap-2 group">
                <span className="mt-0.5 text-xs font-medium text-kk-muted bg-kk-soft border border-kk-line rounded px-1.5 py-0.5 shrink-0 leading-none">
                  {getDriveFileTypeLabel(file.mimeType)}
                </span>
                <div className="flex-1 min-w-0">
                  <a
                    href={file.webViewLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-kk-ink hover:underline break-words leading-snug"
                  >
                    {file.fileName}
                  </a>
                  {file.ownerEmail && (
                    <div className="text-xs text-kk-muted mt-0.5 truncate">
                      {file.ownerEmail}
                    </div>
                  )}
                </div>
                {canManage && (
                  <button
                    onClick={() => handleDetach(file.entitySourceId)}
                    disabled={removingId === file.entitySourceId}
                    className="text-xs text-kk-muted hover:text-kk-bad transition-colors disabled:opacity-40 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100"
                    aria-label={`Remove ${file.fileName}`}
                    title="Remove"
                  >
                    {removingId === file.entitySourceId ? '…' : '×'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {initialFiles.length === 0 && !canManage && (
          <p className="text-sm text-kk-muted">No related files.</p>
        )}

        {/* Attach form */}
        {canManage && driveEnabled && (
          <form onSubmit={handleAttach} className="space-y-2 pt-1">
            <div className="flex gap-2">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste a Google Drive or Docs link…"
                className="flex-1 min-w-0 text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
                disabled={attaching}
              />
              <button
                type="submit"
                disabled={attaching || !url.trim()}
                className="px-3 py-2 bg-kk-ink text-white text-sm rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity shrink-0"
              >
                {attaching ? '…' : 'Attach'}
              </button>
            </div>
            {error && (
              <p className="text-xs text-kk-bad">{error}</p>
            )}
          </form>
        )}

        {/* Drive not connected prompt */}
        {canManage && !driveEnabled && (
          <p className="text-xs text-kk-muted">
            <a href="/settings" className="underline hover:text-kk-ink transition-colors">
              Enable Google Drive in Settings
            </a>{' '}
            to attach related documents.
          </p>
        )}
      </div>
    </div>
  )
}
