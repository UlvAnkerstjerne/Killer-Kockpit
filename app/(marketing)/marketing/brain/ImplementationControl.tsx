'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { confirmStrategyImplementation, prepareStrategyImplementation, type PrepareResult } from '@/lib/actions/marketing/paid-strategy-implementation'
import { confirmLabel, modeLabel, stateLabel } from '@/lib/marketing/paid-strategy/implementation/state'
import PreviewPanel, { DialogFrame, dkk } from './ImplementationPreview'
import type { ImplementationInputs, ImplementationView } from '@/lib/marketing/paid-strategy/implementation/types'

type Ready = Extract<PrepareResult, { alreadyStarted: false }>
const IN_FLIGHT = new Set(['approved', 'started', 'in_motion', 'completed', 'cancelled', 'needs_attention'])

export default function ImplementationControl({ runId, index, canApprove, superseded, view }: {
  runId: string; index: number; canApprove: boolean; superseded: boolean; view?: ImplementationView
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [ready, setReady] = useState<Ready | null>(null)
  const [error, setError] = useState('')
  const [owner, setOwner] = useState('')
  const [due, setDue] = useState('')
  const [reserve, setReserve] = useState('')
  const [targetId, setTargetId] = useState('')
  const [action, setAction] = useState<'' | 'pause_campaign' | 'resume_campaign' | 'set_daily_budget'>('')
  const [newBudget, setNewBudget] = useState('')
  const [location, setLocation] = useState('')
  const opener = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const close = () => { setOpen(false); setReady(null); setError(''); opener.current?.focus() }
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  useEffect(() => { if (ready) cancelRef.current?.focus() }, [ready])

  // Settled or in-flight work shows its state instead of a button; nothing can be approved twice from the card.
  if (view && IN_FLIGHT.has(view.status)) {
    return <div className="mt-4 border-t border-kk-line pt-3 text-sm" aria-label="Implementation state">
      <p><span className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">Implementation</span><br />
        <span className="font-medium">{stateLabel(view)}</span>{view.budgetReservedDkk > 0 ? <span className="text-kk-muted"> · {dkk(view.budgetReservedDkk)} reserved</span> : null}</p>
      {view.linkedTaskId ? <p className="mt-1"><Link href={`/tasks/${view.linkedTaskId}`} className="text-kk-brand underline">Open the task</Link></p> : null}
      {view.error ? <p className="mt-1 text-xs text-kk-muted">{view.error}</p> : null}
    </div>
  }
  if (superseded) return <p className="mt-4 border-t border-kk-line pt-3 text-xs text-kk-muted">Superseded by newer strategy. Not implementable.</p>
  if (!canApprove) return null

  const collect = (): ImplementationInputs => ({
    ...(owner ? { ownerUserId: owner } : {}), ...(due ? { dueDate: due } : {}),
    ...(reserve !== '' && Number.isFinite(Number(reserve)) ? { reserveBudgetDkk: Number(reserve) } : {}),
    ...(targetId && action ? { platform: {
      action, targetType: ready?.targets.find(t => t.id === targetId)?.type ?? 'campaign', targetId,
      ...(newBudget !== '' && Number.isFinite(Number(newBudget)) ? { targetDailyBudget: Number(newBudget) } : {}),
    } } : {}),
    ...(location.trim() ? { package: { location: location.trim() } } : {}),
  })

  function load(inputs?: ImplementationInputs) {
    startTransition(async () => {
      setError('')
      try {
        const res = await prepareStrategyImplementation(runId, index, inputs)
        if (!res.ok) { setError(res.error); return }
        if (res.alreadyStarted) { router.refresh(); close(); return }
        setReady(res)
        setOwner(o => o || res.defaults.ownerUserId); setDue(d => d || res.defaults.dueDate)
        setReserve(r => r !== '' ? r : String(res.preview.budget.requestedDkk))
        const suggested = res.targets.find(t => t.suggested)
        setTargetId(t => t || suggested?.id || '')
      } catch { setError('Could not prepare this. Nothing was changed.') }
    })
  }

  function confirm() {
    startTransition(async () => {
      setError('')
      try {
        const res = await confirmStrategyImplementation(runId, index, collect())
        if (!res.ok) { setError(res.error); if (res.needsInput) load(collect()); return }
        router.refresh(); close()
      } catch { setError('The result is unknown. Reload to check this recommendation before trying again.') }
    })
  }

  const p = ready?.preview
  const needsInput = p?.mode === 'needs_input'
  const confirmText = confirmLabel(!!p?.changesMeta)

  return <div className="mt-4 border-t border-kk-line pt-3">
    <button ref={opener} type="button" onClick={() => { setOpen(true); load() }}
      className="rounded-xl bg-kk-brand px-4 py-2.5 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kk-brand">
      Approve &amp; implement
    </button>
    {open ? <DialogFrame id={`impl-title-${runId}-${index}`} kicker="Approve & implement" title={p ? modeLabel(p.mode) : 'Preparing…'} onClose={close}
      actions={<>
        <button ref={cancelRef} type="button" onClick={close} className="rounded-xl border border-kk-line px-4 py-2.5 text-sm">Cancel</button>
        <button type="button" disabled={pending || !p || needsInput || !ready?.canConfirm} onClick={confirm}
          className="rounded-xl bg-kk-brand px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60">{pending && p ? 'Working…' : confirmText}</button>
      </>}>
      {!p ? <p role="status" className="mt-3 text-sm text-kk-muted">{error || 'Compiling what Kockpit would do. Nothing is changed yet.'}</p>
        : <PreviewPanel preview={p} targets={ready!.targets} owners={ready!.owners ?? []} minDate={new Date().toISOString().slice(0, 10)} pending={pending}
            form={{ owner, due, reserve, targetId, action, newBudget, location, set: (key, value) => ({ owner: setOwner, due: setDue, reserve: setReserve, targetId: setTargetId, action: (v: string) => setAction(v as typeof action), newBudget: setNewBudget, location: setLocation })[key](value) }}
            onCheck={() => load(collect())} onReserveCommit={() => load(collect())} />}
      {error && p ? <p role="alert" className="mt-3 text-sm">{error}</p> : null}
    </DialogFrame> : null}
  </div>
}
