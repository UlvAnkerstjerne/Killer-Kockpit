import type { ReactNode, RefObject } from 'react'
import type { ClientPreview, PickerTarget } from '@/lib/marketing/paid-strategy/implementation/service'
import { REJECTION_REASON_MAX, type ActivationReview } from '@/lib/marketing/paid-strategy/implementation/types'
import type { Blocker } from '@/lib/marketing/paid-strategy/autonomous/types'

export const dkk = (n: number) => `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(n)} DKK`

export interface PreviewForm {
  owner: string; due: string; targetId: string; action: string; newBudget: string; dailyBudget: string; days: string
  set: (key: 'owner' | 'due' | 'targetId' | 'action' | 'newBudget' | 'dailyBudget' | 'days', value: string) => void
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null
  return <div>
    <p className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">{title}</p>
    <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-relaxed">{items.map(i => <li key={i}>{i}</li>)}</ul>
  </div>
}

export function BlockerList({ title, blockers }: { title: string; blockers: Blocker[] }) {
  if (!blockers.length) return null
  return <div>
    <p className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">{title}</p>
    <ul className="mt-1 space-y-2 text-sm leading-relaxed">{blockers.map(b => <li key={b.code} className="rounded-lg border border-kk-line p-3">
      <p>{b.message}</p>
      <p className="mt-1 text-kk-muted"><span className="font-medium text-current">Smallest unblock:</span> {b.unblock}</p>
    </li>)}</ul>
  </div>
}

/** What Kockpit will do itself, where it expects to stop, and exactly who it will ask for what. Presentational. */
export default function PreviewPanel({ preview: p, targets, owners, minDate, form, pending = false, onCheck }: {
  preview: ClientPreview; targets: PickerTarget[]; owners: { id: string; name: string }[]; minDate: string
  form: PreviewForm; pending?: boolean; onCheck?: () => void
}) {
  const needsInput = p.mode === 'needs_input'
  const platformMode = p.intendedMode === 'platform_action'
  const chosen = targets.find(t => t.id === form.targetId)
  const field = 'mt-1 w-full rounded-lg border border-kk-line bg-transparent px-3 py-2'
  const askForSpend = p.missing.some(m => m.key === 'daily_budget' || m.key === 'duration')
  const showWillDo = !needsInput || p.willDo.length > 0
  return <div className="mt-3 space-y-4">
    <p className="text-sm leading-relaxed">{p.headline}</p>
    {showWillDo ? <List title="Kockpit will" items={p.willDo} /> : null}
    <List title="Kockpit will not" items={p.willNot} />
    <BlockerList title={needsInput ? 'Needed before this can go ahead' : 'Where this will stop today'} blockers={p.expectedBlockers} />
    {needsInput && !p.expectedBlockers.length ? <List title="Needed before this can go ahead" items={p.missing.map(m => m.detail ? `${m.label}: ${m.detail}` : m.label)} /> : null}
    <List title="A person will be asked to" items={needsInput ? [] : p.peopleNeeded} />

    {platformMode ? <fieldset className="space-y-3 rounded-xl border border-kk-line p-3">
      <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-kk-muted">Existing Meta object</legend>
      <label className="block text-sm">Target
        <select value={form.targetId} onChange={e => form.set('targetId', e.target.value)} className={field}>
          <option value="">Choose a synced campaign or ad set</option>
          {targets.map(t => <option key={t.id} value={t.id}>{t.type === 'adset' ? 'Ad set · ' : ''}{t.label} · {t.status}{t.dailyBudgetDkk ? ` · ${dkk(t.dailyBudgetDkk)}/day` : ''}</option>)}
        </select>
      </label>
      <label className="block text-sm">Change
        <select value={form.action} onChange={e => form.set('action', e.target.value)} className={field}>
          <option value="">Choose</option>
          {chosen?.type !== 'adset' ? <option value="pause_campaign">Pause campaign</option> : null}
          {chosen?.type !== 'adset' ? <option value="resume_campaign">Resume campaign</option> : null}
          <option value="set_daily_budget">Set daily budget</option>
        </select>
      </label>
      {form.action === 'set_daily_budget' ? <label className="block text-sm">New daily budget (DKK, within 20% of current)
        <input inputMode="decimal" value={form.newBudget} onChange={e => form.set('newBudget', e.target.value)} className={field} />
      </label> : null}
      <button type="button" disabled={pending || !form.targetId || !form.action} onClick={onCheck} className="rounded-lg border border-kk-line px-3 py-2 text-sm disabled:opacity-60">Check this change</button>
    </fieldset> : null}

    {askForSpend ? <fieldset className="space-y-3 rounded-xl border border-kk-line p-3">
      <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-kk-muted">Spend</legend>
      <label className="block text-sm">Daily budget (DKK)
        <input inputMode="decimal" value={form.dailyBudget} onChange={e => form.set('dailyBudget', e.target.value)} className={field} />
      </label>
      <label className="block text-sm">Days to run
        <input inputMode="numeric" value={form.days} onChange={e => form.set('days', e.target.value)} className={field} />
      </label>
      <button type="button" disabled={pending || !form.dailyBudget || !form.days} onClick={onCheck} className="rounded-lg border border-kk-line px-3 py-2 text-sm disabled:opacity-60">Check this plan</button>
    </fieldset> : null}

    {p.intendedMode === 'creative_execution' && !needsInput ? <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-sm">If filming is needed, assign it to
        <select value={form.owner} onChange={e => form.set('owner', e.target.value)} className={field}>
          {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      <label className="block text-sm">Needed by
        <input type="date" value={form.due} min={minDate} onChange={e => form.set('due', e.target.value)} className={field} />
      </label>
    </div> : null}

    <div className="rounded-xl bg-kk-soft p-3 text-sm">
      <p className="font-medium">
        {p.platform ? `Extra paid-media budget this can add this month: ${dkk(p.platform.incrementalDkk)}`
          : p.spend ? `Extra paid-media budget reserved: ${dkk(p.spend.totalDkk)} (${dkk(p.spend.dailyBudgetDkk)} a day for ${p.spend.durationDays} days)`
          : `Extra paid-media budget: ${dkk(p.budget.requestedDkk)}`}
      </p>
      <p className="mt-1 text-xs text-kk-muted">
        {p.budget.availableDkk == null ? 'No reliable spend headroom this month: no extra paid budget can be approved.' : `${dkk(p.budget.availableDkk)} of the shared headroom is available (${dkk(p.budget.reservedByOthersDkk)} already reserved by other approved work).`}
        {' '}The 15,000 DKK monthly ceiling is a hard cap, not a target.
      </p>
    </div>
  </div>
}

/** The activation review: exactly what will be switched on and what is held constant. */
export function ActivationPanel({ review, totalReserved }: { review: ActivationReview; totalReserved: number }) {
  return <div className="mt-3 space-y-4">
    <dl className="space-y-2.5 text-sm">
      {review.lines.map(l => <div key={l.label}>
        <dt className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">{l.label}</dt>
        <dd className="mt-0.5 whitespace-pre-line leading-relaxed">{l.value}</dd>
      </div>)}
    </dl>
    <List title="Before you switch it on" items={review.notes} />
    <p className="rounded-xl bg-kk-soft p-3 text-sm"><span className="font-medium">Budget reserved: {dkk(totalReserved)}.</span> <span className="text-xs text-kk-muted">Activating starts spending within it. The 15,000 DKK monthly ceiling is a hard cap.</span></p>
  </div>
}

/** The dialog shell: a centred card on desktop, a bottom sheet on phones. */
export function DialogFrame({ id, kicker, title, onClose, children, actions }: { id: string; kicker: string; title: string; onClose?: () => void; children: ReactNode; actions: ReactNode }) {
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
    <div role="dialog" aria-modal="true" aria-labelledby={id} onClick={e => e.stopPropagation()}
      className="flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-kk-line bg-kk-panel shadow-xl sm:max-w-lg sm:rounded-2xl">
      <div className="min-h-0 flex-1 overflow-y-auto p-5 pb-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">{kicker}</p>
        <h3 id={id} className="mt-1 text-base font-semibold leading-snug">{title}</h3>
        {children}
      </div>
      {/* Pinned: the buttons stay in view however long the explanation is. */}
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-kk-line px-5 py-3">{actions}</div>
    </div>
  </div>
}

/** A rejection is a decision about the idea, so this is a compact confirmation with an optional reason, not a form. */
export function RejectDialog({ id, title, reason, onReason, pending, error, reservedDkk, metaObjectsExist, onCancel, onReject, cancelRef, reasonRef }: {
  id: string; title: string; reason: string; onReason: (v: string) => void; pending: boolean; error: string; reservedDkk: number; metaObjectsExist: boolean
  onCancel: () => void; onReject: () => void; cancelRef?: RefObject<HTMLButtonElement | null>; reasonRef?: RefObject<HTMLTextAreaElement | null>
}) {
  return <DialogFrame id={id} kicker="Reject strategy" title={title} onClose={onCancel}
    actions={<>
      <button ref={cancelRef} type="button" onClick={onCancel} className="rounded-xl border border-kk-line px-4 py-2.5 text-sm">Cancel</button>
      <button type="button" disabled={pending} onClick={onReject} className="rounded-xl bg-kk-ink px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60">{pending ? 'Rejecting…' : 'Reject strategy'}</button>
    </>}>
    <label htmlFor={`${id}-reason`} className="mt-4 block text-sm font-medium">Reason (optional)</label>
    <textarea id={`${id}-reason`} ref={reasonRef} value={reason} onChange={e => onReason(e.target.value)} maxLength={REJECTION_REASON_MAX} rows={3}
      placeholder={'e.g. "Not strategically relevant", "We do not want to offer catering in Malmö", "Wrong priority right now"'}
      className="mt-1 w-full rounded-lg border border-kk-line bg-kk-panel px-3 py-2 text-sm" />
    <p className="mt-2 text-xs leading-relaxed text-kk-muted">Future strategy analyses will see this as your decision, not as a performance result. It can still be proposed again if new evidence changes the case.{reservedDkk > 0 ? ` The ${dkk(reservedDkk)} reserved for it is released.` : ''}{metaObjectsExist ? ' Nothing is activated or deleted: the paused objects already created in Meta remain and cannot spend.' : ''}</p>
    {error ? <p role="alert" className="mt-3 text-sm">{error}</p> : null}
  </DialogFrame>
}
