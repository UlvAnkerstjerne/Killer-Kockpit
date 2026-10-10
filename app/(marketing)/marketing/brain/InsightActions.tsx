'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { chooseInsightAction, listInsightActionAssignees, proposeInsightActions } from '@/lib/actions/marketing/insight-actions'
import { insightSinceAction, SINCE_LABEL } from '@/lib/marketing/insights/actions/result'
import { ACTION_KIND_LABEL, ACTION_STATUS_LABEL, type ActionView } from '@/lib/marketing/insights/actions/types'
import type { ImplementationView } from '@/lib/marketing/paid-strategy/implementation/types'
import ImplementationControl from './ImplementationControl'

const day = (value: string | null) => (value ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '')
const TASK_LABEL: Record<string, string> = { proposed: 'Proposed', open: 'Open', in_progress: 'In progress', blocked: 'Blocked', pending_review: 'Waiting for review', done: 'Done', cancelled: 'Cancelled' }
const BUTTON = 'rounded-xl border border-kk-line bg-kk-panel px-3.5 py-2 text-sm font-medium hover:bg-kk-soft disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kk-brand'
const PRIMARY = 'rounded-xl bg-kk-brand px-3.5 py-2 text-sm font-medium text-white disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kk-brand'
const defaultDue = () => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10) }

export interface ImplementationProps { runId: string; index: number; canApprove: boolean; superseded: boolean; title: string; view?: ImplementationView }

function ActionSummary({ action, current }: { action: ActionView; current: { strength: string; times_observed: number } }) {
  const since = action.status === 'completed' ? insightSinceAction(action.outcome, current) : null
  return <li data-insight-action data-status={action.status} className="rounded-xl border border-kk-line bg-kk-soft/40 p-3 text-sm">
    <p className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">{ACTION_KIND_LABEL[action.kind]} · {ACTION_STATUS_LABEL[action.status]}</p>
    <p className="mt-1 font-medium leading-snug">{action.title}</p>
    <p className="mt-1 text-xs text-kk-muted">
      {action.live?.source === 'task' ? <>Task: {TASK_LABEL[action.live.status] ?? action.live.status}{action.live.dueAt && action.live.status !== 'done' ? ` · due ${day(action.live.dueAt)}` : ''}{action.live.completedAt ? ` · finished ${day(action.live.completedAt)}` : ''}{action.linked_task_id ? <> · <Link href={`/tasks/${action.linked_task_id}`} className="underline underline-offset-4">Open task</Link></> : null}</> : null}
      {action.live?.source === 'implementation' ? <>Status: {action.live.label}</> : null}
      {!action.live && action.status === 'chosen' ? 'Chosen' : null}
      {action.status === 'abandoned' ? ` · stopped${action.completed_at ? ` ${day(action.completed_at)}` : ''}` : null}
    </p>
    {since ? <p className="mt-1 text-xs text-kk-muted">Since it was done: {SINCE_LABEL[since]}. That is what later analyses show, not proof that the action caused it.</p> : null}
  </li>
}

/**
 * "Do something about it". Options are drafted only when this button is clicked, and nothing is created or run until one is chosen.
 * A task option creates one task; the Paid Strategy option only opens that recommendation's own Approve & implement controls below,
 * so its permissions, preview and confirmation are exactly the existing ones.
 */
export default function InsightActions({ insightId, actions, implementation, current }: {
  insightId: string; actions: ActionView[]; implementation: ImplementationProps | null; current: { strength: string; times_observed: number }
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [options, setOptions] = useState<ActionView[]>(() => actions.filter(a => a.status === 'proposed'))
  const [selected, setSelected] = useState('')
  const [owner, setOwner] = useState(''); const [due, setDue] = useState(defaultDue())
  const [people, setPeople] = useState<{ id: string; name: string }[] | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const tracked = actions.filter(a => a.status === 'chosen' || a.status === 'completed' || a.status === 'abandoned')
  const chosen = options.find(o => o.id === selected)
  const needsPerson = chosen && chosen.kind !== 'implement_recommendation'

  function draft(redraft: boolean) {
    setError(''); setMessage('')
    startTransition(async () => {
      const result = await proposeInsightActions(insightId, redraft)
      if (!result.ok) { setError(result.error); return }
      setOptions(result.actions.map(a => ({ ...a, live: null }))); setSelected('')
    })
  }
  function pick(id: string) {
    setSelected(id); setError('')
    const option = options.find(o => o.id === id)
    if (option && option.kind !== 'implement_recommendation' && !people) {
      startTransition(async () => { const r = await listInsightActionAssignees(); if (r.ok) setPeople(r.people) })
    }
  }
  function choose() {
    if (!chosen) return
    setError('')
    startTransition(async () => {
      const result = await chooseInsightAction(chosen.id, needsPerson ? { ownerUserId: owner || undefined, dueOn: due } : {})
      if (!result.ok) { setError(result.error); return }
      setOptions([]); setSelected('')
      setMessage(chosen.kind === 'implement_recommendation' ? 'Chosen. Review and confirm it in the Approve & implement controls below; nothing runs until you do.' : 'Task created.')
      router.refresh()
    })
  }

  return <div data-insight-actions className="mt-4 space-y-3">
    {tracked.length ? <ul className="space-y-2">{tracked.map(a => <ActionSummary key={a.id} action={a} current={current} />)}</ul> : null}
    {implementation && tracked.some(a => a.kind === 'implement_recommendation' && a.status === 'chosen') ? <div data-insight-implementation className="rounded-xl border border-kk-line p-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-kk-muted">Approve &amp; implement · {implementation.title}</p>
      <ImplementationControl runId={implementation.runId} index={implementation.index} canApprove={implementation.canApprove} superseded={implementation.superseded} title={implementation.title} view={implementation.view} />
    </div> : null}

    {options.length ? <fieldset data-insight-options className="space-y-2">
      <legend className="text-sm font-medium">Choose one. Nothing happens until you do.</legend>
      {options.map(o => <label key={o.id} className={`block cursor-pointer rounded-xl border p-3 text-sm ${selected === o.id ? 'border-kk-brand bg-kk-brand/5' : 'border-kk-line'}`}>
        <span className="flex items-start gap-2">
          <input type="radio" name={`opt-${insightId}`} value={o.id} checked={selected === o.id} onChange={() => pick(o.id)} className="mt-1" />
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-kk-muted">{ACTION_KIND_LABEL[o.kind]}</span>
            <span className="mt-0.5 block font-medium leading-snug">{o.title}</span>
            <span className="mt-1 block text-kk-muted">{o.why}</span>
            <ol className="mt-2 list-decimal space-y-0.5 pl-5">{o.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            {o.brief ? <span className="mt-2 block rounded-lg bg-kk-soft p-2 text-xs"><strong>Brief:</strong> {o.brief.concept} <em>Hook:</em> {o.brief.hook}<span className="mt-1 block text-kk-muted">For a person to produce. Kockpit does not film, publish or schedule content.</span></span> : null}
            {o.success_signal ? <span className="mt-2 block text-xs text-kk-muted"><strong>Afterwards, look at:</strong> {o.success_signal}</span> : null}
          </span>
        </span>
      </label>)}
      {chosen ? <div className="flex flex-wrap items-end gap-3 pt-1">
        {needsPerson ? <>
          <label className="text-xs text-kk-muted">Owner<select value={owner} onChange={e => setOwner(e.target.value)} className="mt-1 block rounded-lg border border-kk-line bg-kk-panel px-2 py-1.5 text-sm text-kk-ink">
            <option value="">Me</option>{(people ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="text-xs text-kk-muted">Due<input type="date" value={due} onChange={e => setDue(e.target.value)} className="mt-1 block rounded-lg border border-kk-line bg-kk-panel px-2 py-1.5 text-sm text-kk-ink" /></label>
        </> : null}
        <button type="button" disabled={pending} onClick={choose} className={PRIMARY}>{pending ? 'Working…' : needsPerson ? 'Create this task' : 'Choose and open Approve & implement'}</button>
      </div> : null}
      <button type="button" disabled={pending} onClick={() => draft(true)} className="text-xs text-kk-muted underline underline-offset-4">Draft different options</button>
    </fieldset> : <button type="button" disabled={pending} onClick={() => draft(false)} className={BUTTON}>{pending ? 'Drafting options…' : 'Do something about it'}</button>}

    <p role="status" aria-live="polite" className="text-xs text-kk-muted">{pending && !options.length ? 'Drafting options from this insight. Nothing is created yet.' : message}</p>
    {error ? <p role="alert" className="text-xs text-[#C95A35]">{error}</p> : null}
  </div>
}
