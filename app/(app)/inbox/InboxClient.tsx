'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { GmailMessageMeta } from '@/lib/google/gmail'
import { createTaskFromEmail, createWaitingOnFromEmail, fetchMoreInboxMessages } from '@/lib/actions/gmail'

// Mirrors TaskForm / WaitingOnForm option sets exactly
const PRIORITY_OPTIONS = [
  { value: 1, label: '1 — Critical' },
  { value: 2, label: '2 — Normal' },
  { value: 3, label: '3 — Low' },
  { value: 4, label: '4 — Background' },
] as const

const TASK_STATUS_OPTIONS = [
  { value: 'proposed',    label: 'Proposed' },
  { value: 'open',        label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked',     label: 'Blocked' },
] as const

type User    = { id: string; display_name: string; email: string }
type Project = { id: string; title: string }
type DeadlineHint = { dueDate: string | null; evidence: string | null } | null

type Props = {
  initialMessages:      GmailMessageMeta[]
  initialNextPageToken: string | null
  currentUserId:        string
  users:                User[]
  projects:             Project[]
  canAssign:            boolean
}

/** Converts an ISO string to the YYYY-MM-DDTHH:MM format for datetime-local inputs. */
function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  return iso.slice(0, 16)
}

/** Extracts the sender name from "Name <email>" or returns the full from string. */
function senderName(from: string): string {
  const match = from.match(/^(.+?)\s*</)
  return match ? match[1].trim() : from
}

export default function InboxClient({
  initialMessages,
  initialNextPageToken,
  currentUserId,
  users,
  projects,
  canAssign,
}: Props) {
  const router = useRouter()

  // ── Message list + pagination ─────────────────────────────────────────────
  const [messages, setMessages]           = useState<GmailMessageMeta[]>(initialMessages)
  const [nextPageToken, setNextPageToken] = useState<string | null>(initialNextPageToken)
  const [loadingMore, setLoadingMore]     = useState(false)

  // ── Message selection ────────────────────────────────────────────────────
  const [selected, setSelected]           = useState<GmailMessageMeta | null>(null)
  const [body, setBody]                   = useState<string | null>(null)
  const [bodyLoading, setBodyLoading]     = useState(false)
  const [deadlineHint, setDeadlineHint]   = useState<DeadlineHint>(null)
  const [createMode, setCreateMode]       = useState<'task' | 'waiting-on' | null>(null)

  // ── Task form state ──────────────────────────────────────────────────────
  const [taskTitle,   setTaskTitle]   = useState('')
  const [taskDesc,    setTaskDesc]    = useState('')
  const [taskOwner,   setTaskOwner]   = useState(currentUserId)
  const [taskProject, setTaskProject] = useState('')
  const [taskPriority,setTaskPriority]= useState<1|2|3|4>(2)
  const [taskStatus,  setTaskStatus]  = useState<string>('open')
  const [taskDueAt,   setTaskDueAt]   = useState('')

  // ── Waiting-on form state ────────────────────────────────────────────────
  const [woTitle,          setWoTitle]          = useState('')
  const [woUseExternal,    setWoUseExternal]    = useState(true)
  const [woForUserId,      setWoForUserId]      = useState('')
  const [woForName,        setWoForName]        = useState('')
  const [woOwner,          setWoOwner]          = useState(currentUserId)
  const [woProject,        setWoProject]        = useState('')
  const [woDueAt,          setWoDueAt]          = useState('')
  const [woNotes,          setWoNotes]          = useState('')

  // ── Shared submission state ──────────────────────────────────────────────
  const [saving,     setSaving]     = useState(false)
  const [formError,  setFormError]  = useState<string | null>(null)

  // ── Load more ─────────────────────────────────────────────────────────────

  async function handleLoadMore() {
    if (!nextPageToken || loadingMore) return
    setLoadingMore(true)
    const result = await fetchMoreInboxMessages(nextPageToken)
    setLoadingMore(false)
    if (!result.error) {
      setMessages((prev) => [...prev, ...result.messages])
      setNextPageToken(result.nextPageToken)
    }
  }

  // ── Message selection ────────────────────────────────────────────────────

  async function selectMessage(msg: GmailMessageMeta) {
    if (msg.messageId === selected?.messageId) return
    setSelected(msg)
    setBody(null)
    setDeadlineHint(null)
    setCreateMode(null)
    setFormError(null)
    setBodyLoading(true)
    try {
      const res = await fetch(`/api/gmail/message/${msg.messageId}`)
      if (res.ok) {
        const data = await res.json()
        setBody(data.body ?? '')
        setDeadlineHint(data.deadline ?? null)
      } else {
        setBody('')
      }
    } finally {
      setBodyLoading(false)
    }
  }

  // ── Form openers ─────────────────────────────────────────────────────────

  function openTaskForm() {
    setCreateMode('task')
    setTaskTitle(selected?.subject ?? '')
    setTaskDesc('')
    setTaskOwner(currentUserId)
    setTaskProject('')
    setTaskPriority(2)
    setTaskStatus('open')
    // Pre-fill deadline from extraction if available
    setTaskDueAt(deadlineHint?.dueDate ? toDatetimeLocal(deadlineHint.dueDate) : '')
    setFormError(null)
  }

  function openWoForm() {
    setCreateMode('waiting-on')
    setWoTitle(selected?.subject ?? '')
    setWoUseExternal(true)
    setWoForUserId('')
    // Pre-fill sender as "waiting for" when using external mode
    setWoForName(selected ? senderName(selected.from) : '')
    setWoOwner(currentUserId)
    setWoProject('')
    // Pre-fill deadline from extraction if available
    setWoDueAt(deadlineHint?.dueDate ? toDatetimeLocal(deadlineHint.dueDate) : '')
    setWoNotes('')
    setFormError(null)
  }

  // ── Submission handlers ───────────────────────────────────────────────────

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault()
    if (!selected || !taskTitle.trim() || saving) return
    setSaving(true)
    setFormError(null)
    const result = await createTaskFromEmail(selected.messageId, {
      title:          taskTitle.trim(),
      description:    taskDesc.trim() || undefined,
      owner_user_id:  taskOwner || undefined,
      project_id:     taskProject || undefined,
      priority:       taskPriority,
      status:         taskStatus as 'proposed' | 'open' | 'in_progress' | 'blocked',
      due_at:         taskDueAt || undefined,
    })
    setSaving(false)
    if (result.error) {
      setFormError(result.error)
    } else {
      router.push(`/tasks/${result.data!.id}`)
    }
  }

  async function handleCreateWo(e: React.FormEvent) {
    e.preventDefault()
    if (!selected || !woTitle.trim() || saving) return
    setSaving(true)
    setFormError(null)
    const result = await createWaitingOnFromEmail(selected.messageId, {
      title:               woTitle.trim(),
      owner_user_id:       woOwner || undefined,
      waiting_for_user_id: !woUseExternal && woForUserId ? woForUserId : undefined,
      waiting_for_name:    woUseExternal ? woForName.trim() || undefined : undefined,
      project_id:          woProject || undefined,
      due_at:              woDueAt || undefined,
      notes:               woNotes.trim() || undefined,
    })
    setSaving(false)
    if (result.error) {
      setFormError(result.error)
    } else {
      router.push(`/waiting-ons/${result.data!.id}`)
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function formatDate(date: string) {
    try {
      return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    } catch {
      return date
    }
  }

  // ── Shared field class ────────────────────────────────────────────────────

  const field = 'w-full px-3 py-2 border border-kk-line rounded-xl text-xs text-kk-ink focus:outline-none focus:border-kk-ink transition-colors'

  // ── Empty state ───────────────────────────────────────────────────────────

  if (messages.length === 0) {
    return (
      <div className="bg-kk-panel border border-kk-line rounded-2xl p-8 text-center">
        <p className="text-sm text-kk-muted">Your inbox is empty.</p>
      </div>
    )
  }

  // ── Main layout ───────────────────────────────────────────────────────────

  return (
    <div className="grid grid-cols-5 gap-4" style={{ minHeight: '60vh' }}>

      {/* ── Message list ─────────────────────────────────────────── */}
      <div className="col-span-2 bg-kk-panel border border-kk-line rounded-2xl overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-kk-line shrink-0">
          <span className="text-xs font-semibold text-kk-muted uppercase tracking-wide">
            {messages.length} messages
          </span>
        </div>
        <div className="divide-y divide-kk-line overflow-y-auto flex-1">
          {messages.map((msg) => (
            <button
              key={msg.messageId}
              onClick={() => selectMessage(msg)}
              className={`w-full text-left px-4 py-3 transition-colors ${
                selected?.messageId === msg.messageId ? 'bg-kk-soft' : 'hover:bg-kk-soft'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-xs font-semibold text-kk-ink truncate">{senderName(msg.from)}</div>
                <div className="text-xs text-kk-muted shrink-0">{formatDate(msg.date)}</div>
              </div>
              <div className="text-xs font-medium text-kk-ink truncate mt-0.5">{msg.subject}</div>
              <div className="text-xs text-kk-muted truncate mt-0.5">{msg.snippet}</div>
            </button>
          ))}
          {nextPageToken && (
            <div className="px-4 py-3">
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="w-full text-xs text-kk-muted hover:text-kk-ink transition-colors disabled:opacity-50"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Message panel ────────────────────────────────────────── */}
      <div className="col-span-3 bg-kk-panel border border-kk-line rounded-2xl flex flex-col">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-kk-muted">Select a message to read it</p>
          </div>
        ) : (
          <>
            {/* Email header */}
            <div className="px-5 py-4 border-b border-kk-line shrink-0">
              <div className="text-sm font-semibold text-kk-ink">{selected.subject}</div>
              <div className="text-xs text-kk-muted mt-0.5">From: {selected.from}</div>
              <div className="text-xs text-kk-muted">{selected.date}</div>
            </div>

            {/* Email body */}
            <div className="px-5 py-4 overflow-y-auto flex-1 max-h-60">
              {bodyLoading ? (
                <p className="text-xs text-kk-muted">Loading…</p>
              ) : body !== null ? (
                body ? (
                  <pre className="text-xs text-kk-ink whitespace-pre-wrap font-sans leading-relaxed">{body}</pre>
                ) : (
                  <p className="text-xs text-kk-muted italic">No body content.</p>
                )
              ) : (
                <p className="text-xs text-kk-muted">{selected.snippet}</p>
              )}
            </div>

            {/* ── Action buttons ─────────────────────────────────── */}
            {createMode === null && (
              <div className="px-5 py-3 border-t border-kk-line flex gap-2 shrink-0">
                <button
                  onClick={openTaskForm}
                  className="px-3 py-1.5 bg-kk-ink text-white text-xs font-medium rounded-xl hover:opacity-90 transition-opacity"
                >
                  Save as task
                </button>
                <button
                  onClick={openWoForm}
                  className="px-3 py-1.5 border border-kk-line text-xs text-kk-ink rounded-xl hover:bg-kk-soft transition-colors"
                >
                  Save as waiting on
                </button>
              </div>
            )}

            {/* ── Task creation form ─────────────────────────────── */}
            {createMode === 'task' && (
              <form onSubmit={handleCreateTask} className="px-5 py-4 border-t border-kk-line space-y-3 shrink-0 overflow-y-auto max-h-[55vh]">
                <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide">New task from email</div>

                {/* Title */}
                <div>
                  <label className="block text-xs font-medium text-kk-ink mb-1">Title *</label>
                  <input
                    type="text"
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                    required
                    maxLength={500}
                    disabled={saving}
                    className={field}
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="block text-xs font-medium text-kk-ink mb-1">
                    Description <span className="text-kk-muted font-normal">(optional)</span>
                  </label>
                  <textarea
                    value={taskDesc}
                    onChange={(e) => setTaskDesc(e.target.value)}
                    rows={2}
                    disabled={saving}
                    className={`${field} resize-none`}
                  />
                </div>

                {/* Owner + Priority */}
                <div className="grid grid-cols-2 gap-3">
                  {canAssign ? (
                    <div>
                      <label className="block text-xs font-medium text-kk-ink mb-1">Owner</label>
                      <select
                        value={taskOwner}
                        onChange={(e) => setTaskOwner(e.target.value)}
                        disabled={saving}
                        className={`${field} bg-white`}
                      >
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.display_name}{u.id === currentUserId ? ' (me)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div />
                  )}

                  <div>
                    <label className="block text-xs font-medium text-kk-ink mb-1">Priority</label>
                    <select
                      value={taskPriority}
                      onChange={(e) => setTaskPriority(Number(e.target.value) as 1|2|3|4)}
                      disabled={saving}
                      className={`${field} bg-white`}
                    >
                      {PRIORITY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Status + Due date */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-kk-ink mb-1">Status</label>
                    <select
                      value={taskStatus}
                      onChange={(e) => setTaskStatus(e.target.value)}
                      disabled={saving}
                      className={`${field} bg-white`}
                    >
                      {TASK_STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-kk-ink mb-1">
                      Due date <span className="text-kk-muted font-normal">(optional)</span>
                    </label>
                    <input
                      type="datetime-local"
                      value={taskDueAt}
                      onChange={(e) => setTaskDueAt(e.target.value)}
                      disabled={saving}
                      className={field}
                    />
                    {deadlineHint?.evidence && (
                      <p className="text-xs text-kk-muted mt-1">
                        Suggested from email: &ldquo;{deadlineHint.evidence}&rdquo;
                      </p>
                    )}
                  </div>
                </div>

                {/* Project */}
                {projects.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-kk-ink mb-1">
                      Project <span className="text-kk-muted font-normal">(optional)</span>
                    </label>
                    <select
                      value={taskProject}
                      onChange={(e) => setTaskProject(e.target.value)}
                      disabled={saving}
                      className={`${field} bg-white`}
                    >
                      <option value="">No project</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>{p.title}</option>
                      ))}
                    </select>
                  </div>
                )}

                {formError && <p className="text-xs text-kk-bad">{formError}</p>}

                <div className="flex gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={!taskTitle.trim() || saving}
                    className="px-4 py-1.5 bg-kk-ink text-white text-xs font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
                  >
                    {saving ? 'Creating…' : 'Create task'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreateMode(null)}
                    disabled={saving}
                    className="px-3 py-1.5 border border-kk-line text-xs text-kk-muted rounded-xl hover:bg-kk-soft transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {/* ── Waiting-on creation form ───────────────────────── */}
            {createMode === 'waiting-on' && (
              <form onSubmit={handleCreateWo} className="px-5 py-4 border-t border-kk-line space-y-3 shrink-0 overflow-y-auto max-h-[55vh]">
                <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide">New waiting on from email</div>

                {/* Title */}
                <div>
                  <label className="block text-xs font-medium text-kk-ink mb-1">Title *</label>
                  <input
                    type="text"
                    value={woTitle}
                    onChange={(e) => setWoTitle(e.target.value)}
                    required
                    maxLength={500}
                    disabled={saving}
                    className={field}
                  />
                </div>

                {/* Waiting on — team member or external toggle */}
                <div>
                  <label className="block text-xs font-medium text-kk-ink mb-1.5">Waiting on</label>
                  <div className="flex gap-2 mb-2">
                    <button
                      type="button"
                      onClick={() => setWoUseExternal(false)}
                      className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                        !woUseExternal
                          ? 'bg-kk-ink text-white border-kk-ink'
                          : 'border-kk-line text-kk-muted hover:bg-kk-soft'
                      }`}
                    >
                      Team member
                    </button>
                    <button
                      type="button"
                      onClick={() => setWoUseExternal(true)}
                      className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                        woUseExternal
                          ? 'bg-kk-ink text-white border-kk-ink'
                          : 'border-kk-line text-kk-muted hover:bg-kk-soft'
                      }`}
                    >
                      External / free-text
                    </button>
                  </div>
                  {woUseExternal ? (
                    <input
                      type="text"
                      value={woForName}
                      onChange={(e) => setWoForName(e.target.value)}
                      placeholder="Name or description"
                      maxLength={300}
                      disabled={saving}
                      className={field}
                    />
                  ) : (
                    <select
                      value={woForUserId}
                      onChange={(e) => setWoForUserId(e.target.value)}
                      disabled={saving}
                      className={`${field} bg-white`}
                    >
                      <option value="">Select team member…</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>{u.display_name}</option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Owner (if canAssign) */}
                {canAssign && (
                  <div>
                    <label className="block text-xs font-medium text-kk-ink mb-1">Owner</label>
                    <select
                      value={woOwner}
                      onChange={(e) => setWoOwner(e.target.value)}
                      disabled={saving}
                      className={`${field} bg-white`}
                    >
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.display_name}{u.id === currentUserId ? ' (me)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Project */}
                {projects.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-kk-ink mb-1">
                      Project <span className="text-kk-muted font-normal">(optional)</span>
                    </label>
                    <select
                      value={woProject}
                      onChange={(e) => setWoProject(e.target.value)}
                      disabled={saving}
                      className={`${field} bg-white`}
                    >
                      <option value="">No project</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>{p.title}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Due date */}
                <div>
                  <label className="block text-xs font-medium text-kk-ink mb-1">
                    Due <span className="text-kk-muted font-normal">(optional)</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={woDueAt}
                    onChange={(e) => setWoDueAt(e.target.value)}
                    disabled={saving}
                    className={field}
                  />
                  {deadlineHint?.evidence && (
                    <p className="text-xs text-kk-muted mt-1">
                      Suggested from email: &ldquo;{deadlineHint.evidence}&rdquo;
                    </p>
                  )}
                </div>

                {/* Notes */}
                <div>
                  <label className="block text-xs font-medium text-kk-ink mb-1">
                    Notes <span className="text-kk-muted font-normal">(optional)</span>
                  </label>
                  <textarea
                    value={woNotes}
                    onChange={(e) => setWoNotes(e.target.value)}
                    rows={2}
                    disabled={saving}
                    className={`${field} resize-none`}
                  />
                </div>

                {formError && <p className="text-xs text-kk-bad">{formError}</p>}

                <div className="flex gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={!woTitle.trim() || saving}
                    className="px-4 py-1.5 bg-kk-ink text-white text-xs font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
                  >
                    {saving ? 'Creating…' : 'Create waiting on'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreateMode(null)}
                    disabled={saving}
                    className="px-3 py-1.5 border border-kk-line text-xs text-kk-muted rounded-xl hover:bg-kk-soft transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  )
}
