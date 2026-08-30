'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createDecision } from '@/lib/actions/decisions'
import type { DecisionStatus } from '@/lib/types'

type Props = {
  projects: { id: string; title: string }[]
  defaultProjectId?: string
  supersedesDecisionId?: string
}

export default function DecisionForm({ projects, defaultProjectId, supersedesDecisionId }: Props) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [decisionText, setDecisionText] = useState('')
  const [rationale, setRationale] = useState('')
  const [projectId, setProjectId] = useState(defaultProjectId ?? '')
  const [decidedAt, setDecidedAt] = useState('')
  const [status, setStatus] = useState<DecisionStatus>('proposed')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !decisionText.trim() || submitting) return

    setSubmitting(true)
    setError(null)

    const result = await createDecision({
      title,
      decision_text: decisionText,
      rationale: rationale || undefined,
      project_id: projectId || undefined,
      decided_at: decidedAt || undefined,
      status,
      supersedes_decision_id: supersedesDecisionId,
    })

    if (result.error) {
      setError(result.error)
      setSubmitting(false)
      return
    }

    router.push(`/decisions/${result.data!.id}`)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Short, descriptive title for the decision"
          required
          maxLength={500}
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Decision</label>
        <textarea
          value={decisionText}
          onChange={(e) => setDecisionText(e.target.value)}
          placeholder="What was decided? Be specific and factual."
          required
          rows={4}
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors resize-none"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Rationale <span className="text-kk-muted font-normal">(optional)</span></label>
        <textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Why was this decision made?"
          rows={3}
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors resize-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1.5">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as DecisionStatus)}
            disabled={submitting}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white"
          >
            <option value="proposed">Proposed</option>
            <option value="approved">Approved</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1.5">Date <span className="text-kk-muted font-normal">(optional)</span></label>
          <input
            type="datetime-local"
            value={decidedAt}
            onChange={(e) => setDecidedAt(e.target.value)}
            disabled={submitting}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Project <span className="text-kk-muted font-normal">(optional)</span></label>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white"
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-kk-bad">{error}</p>}

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={!title.trim() || !decisionText.trim() || submitting}
          className="flex-1 py-2.5 bg-kk-ink text-white text-sm font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          {submitting ? 'Saving…' : 'Record decision'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/decisions')}
          className="px-5 py-2.5 border border-kk-line text-sm text-kk-muted rounded-xl hover:bg-kk-soft transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
