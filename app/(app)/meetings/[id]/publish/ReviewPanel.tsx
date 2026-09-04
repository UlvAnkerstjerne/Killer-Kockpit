'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { updateMeeting, publishMeeting } from '@/lib/actions/meetings'
import { updateMeetingOutcome, removeMeetingOutcome } from '@/lib/actions/meeting-outcomes'

type User = { id: string; display_name: string }
type Project = { id: string; title: string }
type OutcomeKind = 'task' | 'waiting_on' | 'decision'

type Outcome = {
  id: string
  kind: OutcomeKind
  title: string
  payload_json: Record<string, unknown>
  sort_order: number
  ai_draft_id: string | null
}

type Props = {
  meetingId: string
  initialNotes: string
  initialOutcomes: Outcome[]
  allUsers: User[]
  allProjects: Project[]
}

const KIND_LABELS: Record<OutcomeKind, string> = {
  task: 'Task',
  waiting_on: 'Waiting On',
  decision: 'Decision',
}

const KIND_STYLES: Record<OutcomeKind, string> = {
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

function payloadToForm(outcome: Outcome): EditForm {
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

function formToPayload(kind: OutcomeKind, form: EditForm): Record<string, unknown> {
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
      waiting_for_name: form.waiting_for_user_id ? null : form.waiting_for_name || null,
      project_id: form.project_id || null,
      due_at: form.due_at || null,
    }
  }
  // decision
  return {
    decision_text: form.decision_text || '',
    rationale: form.rationale || null,
    owner_user_id: form.owner_user_id || null,
  }
}

const inputCls =
  'w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white'
const selectCls =
  'w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-kk-muted mb-1">{label}</label>
      {children}
    </div>
  )
}

export default function ReviewPanel({
  meetingId,
  initialNotes,
  initialOutcomes,
  allUsers,
  allProjects,
}: Props) {
  const router = useRouter()

  const [notes, setNotes] = useState(initialNotes)
  const [notesSaving, setNotesSaving] = useState(false)
  const [notesSaved, setNotesSaved] = useState(false)
  const [notesError, setNotesError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<EditForm | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)

  function startEdit(outcome: Outcome) {
    setEditingId(outcome.id)
    setEditForm(payloadToForm(outcome))
    setEditError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditForm(null)
    setEditError(null)
  }

  async function saveNotes() {
    setNotesSaving(true)
    setNotesError(null)
    const result = await updateMeeting(meetingId, { working_notes: notes })
    setNotesSaving(false)
    if (result.error) {
      setNotesError(result.error)
    } else {
      setNotesSaved(true)
      setTimeout(() => setNotesSaved(false), 2500)
    }
  }

  async function saveOutcome(outcome: Outcome) {
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

  async function removeOutcome(outcomeId: string) {
    const result = await removeMeetingOutcome(outcomeId, meetingId)
    if (!result.error) router.refresh()
  }

  async function handlePublish() {
    setPublishing(true)
    setPublishError(null)
    const result = await publishMeeting(meetingId)
    if (result.error) {
      setPublishError(result.error)
      setPublishing(false)
    } else {
      router.push(`/meetings/${meetingId}`)
    }
  }

  return (
    <div className="space-y-4">
      {/* Proposed outcomes */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl">
        <div className="px-5 py-4 border-b border-kk-line">
          <h2 className="text-sm font-semibold text-kk-ink">
            Proposed outcomes to create{' '}
            <span className="text-kk-muted font-normal">· {initialOutcomes.length}</span>
          </h2>
        </div>

        {/* AI provenance notice */}
        {(() => {
          const aiCount = initialOutcomes.filter(o => o.ai_draft_id).length
          return aiCount > 0 ? (
            <div className="px-5 py-2.5 border-b border-kk-line bg-purple-50/50 flex items-center gap-2">
              <span className="text-xs font-medium text-purple-700">✦</span>
              <span className="text-xs text-kk-muted">
                {aiCount} of {initialOutcomes.length} outcome{initialOutcomes.length !== 1 ? 's' : ''} proposed by AI draft
              </span>
            </div>
          ) : null
        })()}

        <div className="divide-y divide-kk-line">
          {initialOutcomes.map((outcome) => {
            const isEditing = editingId === outcome.id
            return (
              <div key={outcome.id}>
                {/* Summary row */}
                <div className="flex items-center gap-3 px-5 py-3.5">
                  <span
                    className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${KIND_STYLES[outcome.kind]}`}
                  >
                    {KIND_LABELS[outcome.kind]}
                  </span>
                  {outcome.ai_draft_id && (
                    <span className="text-xs font-medium text-purple-600 shrink-0">✦ AI</span>
                  )}
                  <span className="text-sm text-kk-ink flex-1 truncate">{outcome.title}</span>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      onClick={() => (isEditing ? cancelEdit() : startEdit(outcome))}
                      className="text-xs text-kk-muted hover:text-kk-ink transition-colors"
                    >
                      {isEditing ? 'Cancel' : 'Edit'}
                    </button>
                    <button
                      onClick={() => removeOutcome(outcome.id)}
                      className="text-xs text-kk-muted hover:text-kk-bad transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {/* Inline edit panel */}
                {isEditing && editForm && (
                  <div className="px-5 pb-4 pt-3 space-y-3 bg-kk-soft border-t border-kk-line">
                    <Field label="Title">
                      <input
                        type="text"
                        value={editForm.title}
                        onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
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
                                setEditForm({ ...editForm, owner_user_id: e.target.value })
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
                                setEditForm({ ...editForm, priority: e.target.value })
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
                                setEditForm({ ...editForm, due_at: e.target.value })
                              }
                              className={inputCls}
                            />
                          </Field>
                          <Field label="Project">
                            <select
                              value={editForm.project_id}
                              onChange={(e) =>
                                setEditForm({ ...editForm, project_id: e.target.value })
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
                                setEditForm({ ...editForm, owner_user_id: e.target.value })
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
                                setEditForm({ ...editForm, waiting_for_user_id: e.target.value })
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
                                setEditForm({ ...editForm, waiting_for_name: e.target.value })
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
                                setEditForm({ ...editForm, due_at: e.target.value })
                              }
                              className={inputCls}
                            />
                          </Field>
                          <Field label="Project">
                            <select
                              value={editForm.project_id}
                              onChange={(e) =>
                                setEditForm({ ...editForm, project_id: e.target.value })
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
                              setEditForm({ ...editForm, decision_text: e.target.value })
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
                              setEditForm({ ...editForm, rationale: e.target.value })
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
                              setEditForm({ ...editForm, owner_user_id: e.target.value })
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

                    {editError && <p className="text-xs text-kk-bad">{editError}</p>}

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

          {initialOutcomes.length === 0 && (
            <div className="px-5 py-6 text-center text-sm text-kk-muted">
              No proposed outcomes. Publishing will still mark the meeting as published.
            </div>
          )}
        </div>
      </div>

      {/* Meeting summary / minutes */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl">
        <div className="px-5 py-4 border-b border-kk-line">
          <h2 className="text-sm font-semibold text-kk-ink">Meeting summary / minutes</h2>
        </div>
        <div className="p-5 space-y-3">
          <textarea
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value)
              setNotesSaved(false)
            }}
            rows={8}
            placeholder="Final meeting notes and summary…"
            className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors resize-y"
          />
          {notesError && <p className="text-xs text-kk-bad">{notesError}</p>}
          <div className="flex items-center gap-3">
            <button
              onClick={saveNotes}
              disabled={notesSaving}
              className="px-4 py-2 bg-kk-ink text-white text-sm rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
            >
              {notesSaving ? 'Saving…' : 'Save notes'}
            </button>
            {notesSaved && <span className="text-xs text-kk-good">Saved</span>}
          </div>
        </div>
      </div>

      {/* Publish / back */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl p-5 space-y-3">
        <button
          onClick={handlePublish}
          disabled={publishing}
          className="w-full py-3 bg-kk-good-bg text-kk-good text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {publishing ? 'Publishing…' : 'Publish minutes & create all outcomes'}
        </button>
        {publishError && <p className="text-sm text-kk-bad">{publishError}</p>}
        <Link
          href={`/meetings/${meetingId}`}
          className="block w-full py-3 border border-kk-line text-sm text-kk-muted rounded-xl hover:bg-kk-soft transition-colors text-center"
        >
          Back to meeting
        </Link>
      </div>
    </div>
  )
}
