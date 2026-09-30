'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { updateDecision } from '@/lib/actions/decisions'
import type { DecisionStatus } from '@/lib/types'

type DecisionData = {
  id: string
  title: string
  decision_text: string
  rationale: string | null
  status: string
  decided_at: string | null
  project_id: string | null
}

type Props = {
  decision: DecisionData
  projects: { id: string; title: string }[]
}

export default function EditDecisionForm({ decision, projects }: Props) {
  const router = useRouter()
  const [title, setTitle] = useState(decision.title)
  const [decisionText, setDecisionText] = useState(decision.decision_text)
  const [rationale, setRationale] = useState(decision.rationale ?? '')
  const [projectId, setProjectId] = useState(decision.project_id ?? '')
  const [decidedAt, setDecidedAt] = useState(decision.decided_at ?? '')
  const [status, setStatus] = useState<DecisionStatus>(decision.status as DecisionStatus)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !decisionText.trim() || submitting) return

    setSubmitting(true)
    setError(null)

    const result = await updateDecision(decision.id, {
      title,
      decision_text: decisionText,
      rationale: rationale || undefined,
      project_id: projectId || undefined,
      decided_at: decidedAt || undefined,
      status,
    })

    if (result.error) {
      setError(result.error)
      setSubmitting(false)
      return
    }

    router.push(`/decisions/${decision.id}`)
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
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Context and reasoning</label>
        <textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Background, reasoning, and implications of this decision"
          rows={5}
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
          className="flex-1 py-2.5 bg-[#171717] text-kraft-light text-sm font-medium rounded-lg disabled:opacity-40 hover:opacity-80 transition-opacity [box-shadow:3px_3px_0_#555555]"
        >
          {submitting ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/decisions/${decision.id}`)}
          className="px-5 py-2.5 bg-kraft-light text-[#171717] border-2 border-[#171717] text-sm font-medium rounded-lg hover:opacity-80 transition-opacity [box-shadow:3px_3px_0_#555555]"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
