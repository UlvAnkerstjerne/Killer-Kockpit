'use client'

import { useState, useTransition } from 'react'
import { generateWeeklyImpactPreviewAction } from '@/lib/actions/weekly-impact'
import type { WeeklyImpactPreview } from '@/lib/weekly-impact/types'
import ActivityClusterInspector from './ActivityClusterInspector'

interface UserOption { id: string; display_name: string; email: string }

export default function WeeklyImpactPreviewClient({
  users,
  initialUserId,
  initialWeek,
}: {
  users: UserOption[]
  initialUserId: string
  initialWeek: string
}) {
  const [userId, setUserId] = useState(initialUserId)
  const [week, setWeek] = useState(initialWeek)
  const [preview, setPreview] = useState<WeeklyImpactPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function generate() {
    setError(null)
    startTransition(async () => {
      const result = await generateWeeklyImpactPreviewAction(userId, week)
      if (result.error || !result.data) {
        setPreview(null)
        setError(result.error ?? 'Preview generation failed.')
        return
      }
      setPreview(result.data)
    })
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-kk-line bg-kk-panel p-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px_auto] sm:items-end">
          <label className="block min-w-0">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-kk-muted">Person</span>
            <select value={userId} onChange={event => setUserId(event.target.value)} className="w-full rounded-lg border border-kk-line bg-white px-3 py-2.5 text-sm text-kk-ink">
              {users.map(user => <option key={user.id} value={user.id}>{user.display_name} · {user.email}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-kk-muted">Week containing</span>
            <input type="date" value={week} max={initialWeek} onChange={event => setWeek(event.target.value)} className="w-full rounded-lg border border-kk-line bg-white px-3 py-2.5 text-sm text-kk-ink" />
          </label>
          <button type="button" onClick={generate} disabled={isPending || !userId} className="rounded-lg bg-kk-ink px-4 py-2.5 text-sm font-bold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
            {isPending ? 'Analysing…' : 'Generate preview'}
          </button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-kk-muted">Preview only. This does not send email or create a delivery record.</p>
        {error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-kk-brand">{error}</p>}
      </section>

      {preview && (
        <>
          <section className="rounded-xl border border-kk-line bg-kk-panel p-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-kk-muted">Generated email</p>
                <h2 className="mt-1 text-lg font-black text-kk-ink">{preview.subject}</h2>
                <p className="mt-1 text-xs text-kk-muted">{preview.evidence.user.name} · {preview.model} · {preview.promptVersion}</p>
              </div>
              <span className="w-fit rounded-full bg-kk-warn-bg px-2.5 py-1 text-xs font-bold text-kk-warn">Not sent</span>
            </div>
          </section>

          <iframe
            title={`Weekly Impact Brief preview for ${preview.evidence.user.name}`}
            srcDoc={preview.html}
            sandbox=""
            className="h-[920px] w-full rounded-xl border border-kk-line bg-white"
          />

          {preview.activityAnalysis ? <ActivityClusterInspector analysis={preview.activityAnalysis} /> : null}

          <details className="rounded-xl border border-kk-line bg-kk-panel p-5">
            <summary className="cursor-pointer text-sm font-bold text-kk-ink">Inspect structured evidence ({Object.values(preview.evidence.counts).reduce((sum, count) => sum + count, 0)} recorded movements)</summary>
            <p className="mt-3 text-xs leading-relaxed text-kk-muted">This is the complete source evidence pack. Completed work is grouped before synthesis. The preview does not use Gmail or unstructured external inference.</p>
            <pre className="mt-4 max-h-[520px] overflow-auto whitespace-pre-wrap rounded-lg bg-kk-soft p-4 text-xs leading-relaxed text-kk-ink">{JSON.stringify(preview.evidence, null, 2)}</pre>
          </details>
        </>
      )}
    </div>
  )
}
