import type { ReactNode } from 'react'
import type { ClientPreview, PickerTarget } from '@/lib/marketing/paid-strategy/implementation/service'

export const dkk = (n: number) => `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(n)} DKK`

export interface PreviewForm {
  owner: string; due: string; reserve: string; targetId: string; action: string; newBudget: string; location: string
  set: (key: 'owner' | 'due' | 'reserve' | 'targetId' | 'action' | 'newBudget' | 'location', value: string) => void
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null
  return <div>
    <p className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">{title}</p>
    <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-relaxed">{items.map(i => <li key={i}>{i}</li>)}</ul>
  </div>
}

/** What Kockpit will and will not do, in plain words. Presentational: all state lives in ImplementationControl. */
export default function PreviewPanel({ preview: p, targets, owners, minDate, form, pending = false, onCheck, onReserveCommit }: {
  preview: ClientPreview; targets: PickerTarget[]; owners: { id: string; name: string }[]; minDate: string
  form: PreviewForm; pending?: boolean; onCheck?: () => void; onReserveCommit?: () => void
}) {
  const needsInput = p.mode === 'needs_input'
  const platformMode = p.intendedMode === 'platform_action'
  const chosen = targets.find(t => t.id === form.targetId)
  const field = 'mt-1 w-full rounded-lg border border-kk-line bg-transparent px-3 py-2'
  return <div className="mt-3 space-y-4">
    <p className="text-sm leading-relaxed">{p.headline}</p>
    {!needsInput ? <List title="Kockpit will" items={p.willDo} /> : null}
    <List title="Kockpit will not" items={p.willNot} />
    <List title={needsInput ? 'Needed before this can go ahead' : 'A person must'}
      items={needsInput ? (p.missing.length ? p.missing.map(m => m.detail ? `${m.label}: ${m.detail}` : m.label) : p.needsPerson) : p.needsPerson} />
    <List title="Kockpit cannot automate" items={p.cannotAutomate} />

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

    {p.package && !p.package.market ? <label className="block text-sm">Target location (optional)
      <input value={form.location} onChange={e => form.set('location', e.target.value)} maxLength={120} className={field} />
    </label> : null}

    {!p.changesMeta && !needsInput ? <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-sm">Owner
        <select value={form.owner} onChange={e => form.set('owner', e.target.value)} className={field}>
          {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      <label className="block text-sm">Due
        <input type="date" value={form.due} min={minDate} onChange={e => form.set('due', e.target.value)} className={field} />
      </label>
    </div> : null}

    <div className="rounded-xl bg-kk-soft p-3 text-sm">
      <p className="font-medium">{p.platform ? 'Extra paid-media budget this can add this month' : 'Extra paid-media budget'}: {dkk(p.platform ? p.platform.incrementalDkk : p.budget.requestedDkk)}</p>
      {!p.platform && p.budget.proposedDkk > 0 ? <label className="mt-2 block">Reserve up to (DKK, at most {dkk(p.budget.proposedDkk)})
        <input inputMode="decimal" value={form.reserve} onChange={e => form.set('reserve', e.target.value)} onBlur={onReserveCommit} className={field} />
      </label> : null}
      <p className="mt-1 text-xs text-kk-muted">
        {p.budget.availableDkk == null ? 'No reliable spend headroom this month: no extra paid budget can be approved.' : `${dkk(p.budget.availableDkk)} of the shared headroom is available (${dkk(p.budget.reservedByOthersDkk)} already reserved by other approved work).`}
        {' '}The 15,000 DKK monthly ceiling is a hard cap, not a target.
      </p>
    </div>
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
