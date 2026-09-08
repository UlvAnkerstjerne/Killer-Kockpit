'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  createMeetingOutcome,
  removeMeetingOutcome,
  updateMeetingOutcome,
} from '@/lib/actions/meeting-outcomes'
import type { MeetingOutcome, MeetingOutcomeKind } from '@/lib/types'

type User = { id: string; display_name: string }
type Project = { id: string; title: string }

const ENTITY_PATHS: Record<MeetingOutcomeKind, string> = {
  task: '/tasks',
  waiting_on: '/waiting-ons',
  decision: '/decisions',
}

type Props = {
  meetingId: string
  outcomes: MeetingOutcome[]
  canEdit: boolean
  isEditable: boolean
  allUsers?: User[]
  allProjects?: Project[]
}

const KIND_LABELS: Record<MeetingOutcomeKind, string> = {
  task: 'Task',
  waiting_on: 'Waiting On',
  decision: 'Decision',
}

const KIND_STYLES: Record<MeetingOutcomeKind, string> = {
  task: 'bg-blue-50 text-blue-700',
  waiting_on: 'bg-kk-warn-bg text-kk-warn',
  decision: 'bg-purple-50 text-purple-700',
}

const PRIORITY_OPTIONS = [
  { value: '1', label: '1 — Critical' },
  { value: '2', label: '2 — Normal' },
  { value: '3', label: '3 — Low' },
  { value: '4', label: '4 — Background' },
]

type EditForm = {
  title: string
  owner_user_id: string
  priority: string
  due_at: string
  project_id: string
  waiting_for_user_id: string
  waiting_for_name: string
  decision_text: string
  rationale: string
}

export function payloadToForm(outcome: MeetingOutcome): EditForm {
  const p = outcome.payload_json
  return {
    title: outcome.title,
    owner_user_id: (p.owner_user_id as string) || '',
    priority: String(p.priority || 2),
    due_at: p.due_at
      ? new Date(p.due_at as string).toISOString().slice(0, 16)
      : '',
    project_id: (p.project_id as string) || '',
    waiting_for_user_id: (p.waiting_for_user_id as string) || '',
    waiting_for_name: (p.waiting_for_name as string) || '',
    decision_text: (p.decision_text as string) || '',
    rationale: (p.rationale as string) || '',
  }
}

export function formToPayload(
  kind: MeetingOutcomeKind,
  form: EditForm,
): Record<string, unknown> {
  if (kind === 'task') {
    return {
      owner_user_id: form.owner_user_id || null,
      priority: Number(form.priority),
      due_at: form.due_at || null,
      project_id: form.project_id || null,
    }
  }
  if (kind === 'waiting_on') {
    return {
      owner_user_id: form.owner_user_id || null,
      waiting_for_user_id: form.waiting_for_user_id || null,
      waiting_for_name: form.waiting_for_user_id
        ? null
        : form.waiting_for_name || null,
      project_id: form.project_id || null,
      due_at: form.due_at || null,
    }
  }
  return {
    decision_text: form.decision_text || '',
    rationale: form.rationale || null,
    owner_user_id: form.owner_user_id || null,
  }
}

export function shortDate(dt: string | null | undefined): string | null {
  if (!dt) return null
  return new Date(dt as string).toLocaleString('en-GB', {
    timeZone: 'Europe/Copenhagen',
    day: 'numeric',
    month: 'short',
  })
}

/** Returns the WHO and WHEN meta strings for the collapsed summary row. */
export function outcomeMeta(
  outcome: MeetingOutcome,
  allUsers: User[],
): { who: string | null; when: string | null } {
  const p = outcome.payload_json
  let who: string | null = null
  let when: string | null = null

  if (outcome.kind === 'task' || outcome.kind === 'decision') {
    const ownerName = p.owner_user_id
      ? (allUsers.find((u) => u.id === (p.owner_user_id as string))
          ?.display_name ?? null)
      : null
    who = ownerName
  }

  if (outcome.kind === 'waiting_on') {
    if (p.waiting_for_user_id) {
      who =
        allUsers.find((u) => u.id === (p.waiting_for_user_id as string))
          ?.display_name ?? null
    } else {
      who = (p.waiting_for_name as string) || null
    }
  }

  if (outcome.kind !== 'decision') {
    when = shortDate(p.due_at as string | null)
  }

  return { who, when }
}

const inputCls =
  'w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white'
const selectCls =
  'w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white'

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-kk-muted mb-1">
        {label}
      </label>
      {children}
    </div>
  )
}

export default function OutcomesSection({
  meetingId,
  outcomes,
  canEdit,
  isEditable,
  allUsers = [],
  allProjects = [],
}: Props) {
  const router = useRouter()

  // ── Quick-add form ─────────────────────────────────────────────────────────
  const [kind, setKind] = useState<MeetingOutcomeKind>('task')
  const [title, setTitle] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // ── Inline edit ────────────────────────────────────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<EditForm | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const proposed = outcomes.filter((o) => o.status === 'proposed')
  const published = outcomes.filter((o) => o.status === 'published')

  // ── Handlers ───────────────────────────────────────────────────────────────

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || adding) return
    setAdding(true)
    setAddError(null)
    const result = await createMeetingOutcome(meetingId, {
      kind,
      title,
      sort_order: proposed.length,
    })
    if (result.error) {
      setAddError(result.error)
    } else {
      setTitle('')
      router.refresh()
    }
    setAdding(false)
  }

  async function handleRemove(outcomeId: string) {
    const result = await removeMeetingOutcome(outcomeId, meetingId)
    if (!result.error) router.refresh()
  }

  function startEdit(outcome: MeetingOutcome) {
    setEditingId(outcome.id)
    setEditForm(payloadToForm(outcome))
    setEditError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditForm(null)
    setEditError(null)
  }

  async function saveOutcome(outcome: MeetingOutcome) {
    if (!editForm) return
    setEditSaving(true)
    setEditError(null)
    const result = await updateMeetingOutcome(outcome.id, meetingId, {
      title: editForm.title,
      payload_json: formToPayload(outcome.kind, editForm),
    })
    setEditSaving(false)
    if (result.error) {
      setEditError(result.error)
    } else {
      cancelEdit()
      router.refresh()
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">
          Proposed outcomes
          {proposed.length > 0 && (
            <span className="text-kk-muted font-normal ml-1">
              · {proposed.length}
            </span>
          )}
        </h2>
      </div>

      <div className="divide-y divide-kk-line">
        {proposed.map((outcome) => {
          const isEditing = editingId === outcome.id
          const { who, when } = outcomeMeta(outcome, allUsers)

          return (
            <div key={outcome.id}>
              {/* Collapsed summary row */}
              <div className="flex items-start gap-3 px-5 py-3">
                <span
                  className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium shrink-0 mt-0.5 ${KIND_STYLES[outcome.kind]}`}
                >
                  {KIND_LABELS[outcome.kind]}
                </span>

                {/* Title + meta */}
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-kk-ink truncate">
                    {outcome.title}
                  </span>
                  {(who || when) && (
                    <span className="block text-[11px] text-kk-muted mt-0.5">
                      {[who, when].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>

                {canEdit && isEditable && (
                  <div className="flex items-center gap-3 shrink-0 mt-0.5">
                    <button
                      onClick={() => (isEditing ? cancelEdit() : startEdit(outcome))}
                      className="text-xs text-kk-muted hover:text-kk-ink transition-colors"
                    >
                      {isEditing ? 'Cancel' : 'Edit'}
                    </button>
                    <button
                      onClick={() => handleRemove(outcome.id)}
                      className="text-xs text-kk-muted hover:text-kk-bad transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>

              {/* Inline edit panel */}
              {isEditing && editForm && (
                <div className="px-5 pb-4 pt-3 space-y-3 bg-kk-soft border-t border-kk-line">
                  <Field label="Title">
                    <input
                      type="text"
                      value={editForm.title}
                      onChange={(e) =>
                        setEditForm({ ...editForm, title: e.target.value })
                      }
                      className={inputCls}
                    />
                  </Field>

                  {outcome.kind === 'task' && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Responsible">
                          <select
                            value={editForm.owner_user_id}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                owner_user_id: e.target.value,
                              })
                            }
                            className={selectCls}
                          >
                            <option value="">— Unassigned —</option>
                            {allUsers.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.display_name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Priority">
                          <select
                            value={editForm.priority}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                priority: e.target.value,
                              })
                            }
                            className={selectCls}
                          >
                            {PRIORITY_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Deadline">
                          <input
                            type="datetime-local"
                            value={editForm.due_at}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                due_at: e.target.value,
                              })
                            }
                            className={inputCls}
                          />
                        </Field>
                        <Field label="Project">
                          <select
                            value={editForm.project_id}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                project_id: e.target.value,
                              })
                            }
                            className={selectCls}
                          >
                            <option value="">— None —</option>
                            {allProjects.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.title}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                    </>
                  )}

                  {outcome.kind === 'waiting_on' && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Owner">
                          <select
                            value={editForm.owner_user_id}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                owner_user_id: e.target.value,
                              })
                            }
                            className={selectCls}
                          >
                            <option value="">— Unassigned —</option>
                            {allUsers.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.display_name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Waiting for (team member)">
                          <select
                            value={editForm.waiting_for_user_id}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                waiting_for_user_id: e.target.value,
                              })
                            }
                            className={selectCls}
                          >
                            <option value="">— External / free text —</option>
                            {allUsers.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.display_name}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      {!editForm.waiting_for_user_id && (
                        <Field label="Waiting for (name)">
                          <input
                            type="text"
                            value={editForm.waiting_for_name}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                waiting_for_name: e.target.value,
                              })
                            }
                            placeholder="External name…"
                            className={inputCls}
                          />
                        </Field>
                      )}
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Due date">
                          <input
                            type="datetime-local"
                            value={editForm.due_at}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                due_at: e.target.value,
                              })
                            }
                            className={inputCls}
                          />
                        </Field>
                        <Field label="Project">
                          <select
                            value={editForm.project_id}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                project_id: e.target.value,
                              })
                            }
                            className={selectCls}
                          >
                            <option value="">— None —</option>
                            {allProjects.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.title}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                    </>
                  )}

                  {outcome.kind === 'decision' && (
                    <>
                      <Field label="Decision text">
                        <textarea
                          value={editForm.decision_text}
                          onChange={(e) =>
                            setEditForm({
                              ...editForm,
                              decision_text: e.target.value,
                            })
                          }
                          rows={2}
                          placeholder="The decision that was made…"
                          className={`${inputCls} resize-none`}
                        />
                      </Field>
                      <Field label="Rationale">
                        <textarea
                          value={editForm.rationale}
                          onChange={(e) =>
                            setEditForm({
                              ...editForm,
                              rationale: e.target.value,
                            })
                          }
                          rows={2}
                          placeholder="Why this decision was made…"
                          className={`${inputCls} resize-none`}
                        />
                      </Field>
                      <Field label="Owner">
                        <select
                          value={editForm.owner_user_id}
                          onChange={(e) =>
                            setEditForm({
                              ...editForm,
                              owner_user_id: e.target.value,
                            })
                          }
                          className={selectCls}
                        >
                          <option value="">— Unassigned —</option>
                          {allUsers.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.display_name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </>
                  )}

                  {editError && (
                    <p className="text-xs text-kk-bad">{editError}</p>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={() => saveOutcome(outcome)}
                      disabled={editSaving || !editForm.title.trim()}
                      className="px-4 py-2 bg-kk-ink text-white text-sm rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
                    >
                      {editSaving ? 'Saving…' : 'Save changes'}
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="px-4 py-2 border border-kk-line text-sm text-kk-muted rounded-xl hover:bg-kk-line transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {proposed.length === 0 && (
          <div className="px-5 py-4 text-sm text-kk-muted">
            No proposed outcomes yet.
          </div>
        )}
      </div>

      {published.length > 0 && (
        <>
          <div className="px-5 py-3 border-t border-kk-line">
            <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-2">
              Published outcomes
            </div>
            <div className="space-y-2">
              {published.map((outcome) => (
                <div key={outcome.id} className="flex items-center gap-2">
                  <span
                    className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${KIND_STYLES[outcome.kind]}`}
                  >
                    {KIND_LABELS[outcome.kind]}
                  </span>
                  {outcome.published_entity_id ? (
                    <Link
                      href={`${ENTITY_PATHS[outcome.kind]}/${outcome.published_entity_id}`}
                      className="text-sm text-kk-ink hover:underline truncate"
                    >
                      {outcome.title}
                    </Link>
                  ) : (
                    <span className="text-sm text-kk-muted truncate">
                      {outcome.title}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {canEdit && isEditable && (
        <div className="px-5 py-3 border-t border-kk-line">
          <form onSubmit={handleAdd} className="space-y-2">
            <div className="flex gap-2">
              {(['task', 'waiting_on', 'decision'] as MeetingOutcomeKind[]).map(
                (k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      kind === k
                        ? 'bg-kk-ink text-white border-kk-ink'
                        : 'border-kk-line text-kk-muted hover:bg-kk-soft'
                    }`}
                  >
                    {KIND_LABELS[k]}
                  </button>
                ),
              )}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={`Add ${KIND_LABELS[kind].toLowerCase()}…`}
                maxLength={500}
                disabled={adding}
                className="flex-1 px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
              />
              <button
                type="submit"
                disabled={!title.trim() || adding}
                className="px-4 py-2 bg-kk-ink text-white text-sm rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
              >
                Add
              </button>
            </div>
          </form>
          {addError && <p className="text-xs text-kk-bad mt-1">{addError}</p>}
        </div>
      )}
    </div>
  )
}
