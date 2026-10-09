'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  activateStrategyImplementation, cancelStrategyImplementation, confirmStrategyImplementation, prepareStrategyImplementation, rejectStrategyImplementation, resumeStrategyImplementation, type PrepareResult,
} from '@/lib/actions/marketing/paid-strategy-implementation'
import { confirmLabel, modeLabel, stateLabel } from '@/lib/marketing/paid-strategy/implementation/state'
import type { ImplementationInputs, ImplementationView } from '@/lib/marketing/paid-strategy/implementation/types'
import PreviewPanel, { ActivationPanel, BlockerList, DialogFrame, dkk, RejectDialog } from './ImplementationPreview'

type Ready = Extract<PrepareResult, { alreadyStarted: false }>
/** Nothing to approve any more: show the state. */
const SETTLED = new Set(['approved', 'planning', 'executing', 'verifying', 'in_motion', 'completed', 'cancelled', 'started'])
const BLOCKED = new Set(['waiting_for_access', 'waiting_for_input', 'needs_attention'])

const REJECT_BUTTON = 'rounded-xl border border-kk-line px-4 py-2.5 text-sm font-medium text-kk-ink hover:bg-kk-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kk-brand disabled:opacity-60'

export default function ImplementationControl({ runId, index, canApprove, superseded, view, title }: {
  runId: string; index: number; canApprove: boolean; superseded: boolean; view?: ImplementationView; title?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState<'' | 'confirm' | 'activate' | 'reject'>('')
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()
  const [ready, setReady] = useState<Ready | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [owner, setOwner] = useState(''); const [due, setDue] = useState('')
  const [targetId, setTargetId] = useState(''); const [action, setAction] = useState<'' | 'pause_campaign' | 'resume_campaign' | 'set_daily_budget'>(''); const [newBudget, setNewBudget] = useState('')
  const [dailyBudget, setDailyBudget] = useState(''); const [days, setDays] = useState('')
  const opener = useRef<HTMLButtonElement>(null); const cancelRef = useRef<HTMLButtonElement>(null)

  const close = () => { setOpen(''); setReady(null); setError(''); opener.current?.focus() }
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  useEffect(() => { if (ready || open === 'activate') cancelRef.current?.focus() }, [ready, open])

  const collect = (): ImplementationInputs => ({
    ...(owner ? { ownerUserId: owner } : {}), ...(due ? { dueDate: due } : {}),
    ...(targetId && action ? { platform: { action, targetType: ready?.targets.find(t => t.id === targetId)?.type ?? 'campaign', targetId, ...(newBudget !== '' && Number.isFinite(Number(newBudget)) ? { targetDailyBudget: Number(newBudget) } : {}) } } : {}),
    ...(dailyBudget !== '' || days !== '' ? { campaign: { ...(dailyBudget !== '' && Number.isFinite(Number(dailyBudget)) ? { dailyBudgetDkk: Number(dailyBudget) } : {}), ...(days !== '' && Number.isInteger(Number(days)) ? { durationDays: Number(days) } : {}) } } : {}),
  })

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, after?: () => void) => startTransition(async () => {
    setError(''); setNote('')
    try {
      const res = await fn()
      if (!res.ok) { setError(res.error ?? 'That did not work. Nothing was changed.'); return }
      setNote(res.message ?? ''); after?.(); router.refresh()
    } catch { setError('The result is unknown. Reload to check this recommendation before trying again.') }
  })

  function load(inputs?: ImplementationInputs) {
    startTransition(async () => {
      setError('')
      try {
        const res = await prepareStrategyImplementation(runId, index, inputs)
        if (!res.ok) { setError(res.error); return }
        if (res.alreadyStarted) { router.refresh(); close(); return }
        setReady(res); setOwner(o => o || res.defaults.ownerUserId); setDue(d => d || res.defaults.dueDate)
        const suggested = res.targets.find(t => t.suggested); setTargetId(t => t || suggested?.id || '')
      } catch { setError('Could not prepare this. Nothing was changed.') }
    })
  }
  const confirm = () => run(() => confirmStrategyImplementation(runId, index, collect()), close)
  const canReject = canApprove && !superseded
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (open === 'reject') reasonRef.current?.focus() }, [open])
  // Disabled while the request runs and the server treats a repeat as a no-op, so a double click or reload cannot undo or repeat it.
  const reject = () => run(() => rejectStrategyImplementation(runId, index, reason), () => { close(); setReason('') })
  const rejectButton = canReject ? <button type="button" disabled={pending} onClick={() => { setError(''); setOpen('reject') }} className={REJECT_BUTTON}>Reject</button> : null
  const reserved = view?.budgetReservedDkk ?? 0
  const rejectDialog = open === 'reject' ? <RejectDialog id={`rej-title-${runId}-${index}`} title={title ?? 'This recommendation'} reason={reason} onReason={setReason} pending={pending} error={error}
    reservedDkk={reserved} metaObjectsExist={!!view?.metaObjectsExist} onCancel={close} onReject={reject} cancelRef={cancelRef} reasonRef={reasonRef} /> : null

  // ── A rejected strategy: the decision, not a button ───────────────────────────
  if (view?.status === 'rejected') {
    return <div className="mt-4 space-y-2 border-t border-kk-line pt-3 text-sm" aria-label="Strategy decision">
      <p><span className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">Strategy decision</span><br /><span className="font-medium">{stateLabel(view)}</span></p>
      {view.rejectionReason ? <p>&ldquo;{view.rejectionReason}&rdquo;</p> : null}
      {view.metaObjectsExist ? <p className="text-xs text-kk-muted">Paused objects created earlier in Meta remain and cannot spend. Nothing was activated or deleted.</p> : null}
    </div>
  }

  // ── State instead of a button once there is something to show ─────────────────
  if (view && (SETTLED.has(view.status) || BLOCKED.has(view.status) || view.status === 'ready_to_activate')) {
    const blocked = BLOCKED.has(view.status)
    return <div className="mt-4 space-y-3 border-t border-kk-line pt-3 text-sm" aria-label="Implementation state">
      <p><span className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">Implementation · {modeLabel(view.mode)}</span><br />
        <span className="font-medium">{stateLabel(view)}</span>{view.budgetReservedDkk > 0 ? <span className="text-kk-muted"> · {dkk(view.budgetReservedDkk)} reserved</span> : null}</p>
      {blocked && view.blockers.length ? <BlockerList title={view.status === 'waiting_for_access' ? 'What is missing' : 'What is needed'} blockers={view.blockers} /> : null}
      {view.status === 'needs_attention' && view.message ? <p className="text-xs text-kk-muted">{view.message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}{note ? <p role="status" className="text-kk-muted">{note}</p> : null}
      {canApprove && (blocked || view.status === 'planning' || view.status === 'executing') ? <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pending} onClick={() => run(() => resumeStrategyImplementation(runId, index, collect()))} className="rounded-lg border border-kk-line px-3 py-2 disabled:opacity-60">Check again</button>
        {blocked ? <button type="button" disabled={pending} onClick={() => run(() => cancelStrategyImplementation(runId, index))} className="rounded-lg border border-kk-line px-3 py-2 text-kk-muted disabled:opacity-60">Cancel and release budget</button> : null}
        {blocked ? rejectButton : null}
      </div> : null}
      {rejectDialog}
      {view.status === 'ready_to_activate' && view.review ? <>
        <p className="text-xs text-kk-muted">{view.message}</p>
        {canApprove ? <div className="flex flex-wrap gap-2">
          <button ref={opener} type="button" onClick={() => setOpen('activate')} className="rounded-xl bg-kk-brand px-4 py-2.5 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kk-brand">Review &amp; activate</button>
          <button type="button" disabled={pending} onClick={() => run(() => cancelStrategyImplementation(runId, index))} className="rounded-lg border border-kk-line px-3 py-2 text-kk-muted disabled:opacity-60">Cancel</button>
          {rejectButton}
        </div> : null}
        {open === 'activate' ? <DialogFrame id={`act-title-${runId}-${index}`} kicker="Ready to activate" title={view.review.title} onClose={close}
          actions={<>
            <button ref={cancelRef} type="button" onClick={close} className="rounded-xl border border-kk-line px-4 py-2.5 text-sm">Not yet</button>
            <button type="button" disabled={pending} onClick={() => run(() => activateStrategyImplementation(runId, index), close)} className="rounded-xl bg-kk-brand px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60">{pending ? 'Activating…' : view.review.kind === 'campaign' ? 'Activate · spending starts' : 'Activate the ad'}</button>
          </>}>
          <ActivationPanel review={view.review} totalReserved={view.budgetReservedDkk} />
          {error ? <p role="alert" className="mt-3 text-sm">{error}</p> : null}
        </DialogFrame> : null}
      </> : null}
    </div>
  }
  if (superseded) return <p className="mt-4 border-t border-kk-line pt-3 text-xs text-kk-muted">Superseded by newer strategy. Not implementable.</p>
  if (!canApprove) return null

  const p = ready?.preview
  const needsInput = p?.mode === 'needs_input'
  return <div className="mt-4 border-t border-kk-line pt-3">
    <div className="flex flex-wrap gap-2">
      {rejectButton}
      <button ref={opener} type="button" onClick={() => { setOpen('confirm'); load() }}
        className="rounded-xl bg-kk-brand px-4 py-2.5 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kk-brand">
        Approve &amp; implement
      </button>
    </div>
    {error && !open ? <p role="alert" className="mt-2 text-sm">{error}</p> : null}
    {note && !open ? <p role="status" className="mt-2 text-sm text-kk-muted">{note}</p> : null}
    {rejectDialog}
    {open === 'confirm' ? <DialogFrame id={`impl-title-${runId}-${index}`} kicker="Approve & implement" title={p ? modeLabel(p.mode) : 'Preparing…'} onClose={close}
      actions={<>
        <button ref={cancelRef} type="button" onClick={close} className="rounded-xl border border-kk-line px-4 py-2.5 text-sm">Cancel</button>
        <button type="button" disabled={pending || !p || needsInput || !ready?.canConfirm} onClick={confirm}
          className="rounded-xl bg-kk-brand px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60">{pending && p ? 'Working…' : confirmLabel(p?.mode, !!p?.changesMeta)}</button>
      </>}>
      {!p ? <p role="status" className="mt-3 text-sm text-kk-muted">{error || 'Working out what Kockpit would do. Nothing is changed yet.'}</p>
        : <PreviewPanel preview={p} targets={ready!.targets} owners={ready!.owners ?? []} minDate={new Date().toISOString().slice(0, 10)} pending={pending}
            form={{ owner, due, targetId, action, newBudget, dailyBudget, days, set: (key, value) => ({ owner: setOwner, due: setDue, targetId: setTargetId, action: (v: string) => setAction(v as typeof action), newBudget: setNewBudget, dailyBudget: setDailyBudget, days: setDays })[key](value) }}
            onCheck={() => load(collect())} />}
      {error && p ? <p role="alert" className="mt-3 text-sm">{error}</p> : null}
    </DialogFrame> : null}
  </div>
}
