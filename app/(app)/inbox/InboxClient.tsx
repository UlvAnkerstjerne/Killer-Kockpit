'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { GmailMessageMeta } from '@/lib/google/gmail'
import {
  createTaskFromEmail,
  createWaitingOnFromEmail,
  createMeetingFromEmail,
  fetchMoreInboxMessages,
  getMessageActions,
  linkEmailToEntity,
  unlinkEmailFromEntity,
} from '@/lib/actions/gmail'
import type { EmailAction } from '@/lib/actions/gmail'
import { analyzeEmailForSuggestions } from '@/lib/actions/email-intelligence'
import type { EmailAnalysisOutput, EmailSuggestion, MeetingSuggestion } from '@/lib/ai/email-analysis-schema'
import {
  kindLabel,
  kindBadgeClass,
  suggestionDetails,
} from '@/lib/ai/email-suggestion-display'
import { utcToWall } from '@/lib/time'

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

type User     = { id: string; display_name: string; email: string }
type Project  = { id: string; title: string }
type Meeting  = { id: string; title: string }
type Employee = { id: string; name: string }
type Location = { id: string; name: string }
type DeadlineHint = { dueDate: string | null; evidence: string | null } | null

type Props = {
  initialMessages:      GmailMessageMeta[]
  initialNextPageToken: string | null
  currentUserId:        string
  users:                User[]
  projects:             Project[]
  meetings:             Meeting[]
  employees:            Employee[]
  locations:            Location[]
  canAssign:            boolean
  initialActionedIds:   string[]
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

const ENTITY_TYPE_LABEL: Record<string, string> = {
  project:    'Project',
  meeting:    'Meeting',
  employee:   'Person',
  location:   'Location',
  task:       'Task',
  waiting_on: 'Waiting on',
}

// ─── Suggestion card ───────────────────────────────────────────────────────────
//
// Pure display — no create/accept/apply actions. Ephemeral: lives only in
// React state for the currently opened email. Nothing is persisted.

function SuggestionCard({
  suggestion,
  onReviewMeeting,
}: {
  suggestion: EmailSuggestion
  onReviewMeeting?: (s: MeetingSuggestion) => void
}) {
  const details = suggestionDetails(suggestion)

  return (
    <div
      className="border border-kk-line rounded-xl p-3 space-y-2"
      data-testid={`suggestion-card-${suggestion.kind}`}
    >
      {/* Type badge + title */}
      <div className="flex items-start gap-2">
        <span
          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 leading-none mt-px ${kindBadgeClass(suggestion.kind)}`}
          data-testid="suggestion-kind-badge"
        >
          {kindLabel(suggestion.kind)}
        </span>
        <span className="text-xs font-medium text-kk-ink leading-snug">
          {suggestion.title}
        </span>
      </div>

      {/* Detail rows — only present fields */}
      {details.length > 0 && (
        <div className="space-y-0.5">
          {details.map(({ label, value }, i) => (
            <div key={i} className="flex gap-1.5 text-xs">
              <span className="text-kk-muted shrink-0">{label}:</span>
              <span className="text-kk-ink">{value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Evidence excerpt */}
      {suggestion.evidence && (
        <p className="text-[11px] text-kk-muted italic border-l-2 border-kk-line pl-2 leading-snug">
          &ldquo;{suggestion.evidence}&rdquo;
        </p>
      )}

      {/* Reason — most secondary */}
      <p className="text-[11px] text-kk-muted">{suggestion.reason}</p>

      {/* Review action — only for meeting suggestions */}
      {suggestion.kind === 'meeting' && onReviewMeeting && (
        <button
          type="button"
          onClick={() => onReviewMeeting(suggestion as MeetingSuggestion)}
          data-testid="review-meeting-button"
          className="text-xs px-3 py-1 border border-kk-line rounded-lg text-kk-ink hover:bg-kk-soft transition-colors"
        >
          Review meeting
        </button>
      )}
    </div>
  )
}

export default function InboxClient({
  initialMessages,
  initialNextPageToken,
  currentUserId,
  users,
  projects,
  meetings,
  employees,
  locations,
  canAssign,
  initialActionedIds,
}: Props) {
  // ── Message list + pagination ─────────────────────────────────────────────
  const [messages, setMessages]           = useState<GmailMessageMeta[]>(initialMessages)
  const [nextPageToken, setNextPageToken] = useState<string | null>(initialNextPageToken)
  const [loadingMore, setLoadingMore]     = useState(false)

  // ── Actioned state (derived from entity_sources, updated locally) ─────────
  const [actionedIds, setActionedIds] = useState<Set<string>>(new Set(initialActionedIds))

  // ── Message selection ────────────────────────────────────────────────────
  const [selected, setSelected]         = useState<GmailMessageMeta | null>(null)
  const [body, setBody]                 = useState<string | null>(null)
  const [bodyLoading, setBodyLoading]   = useState(false)
  const [deadlineHint, setDeadlineHint] = useState<DeadlineHint>(null)
  const [createMode, setCreateMode]     = useState<'task' | 'waiting-on' | 'meeting' | null>(null)

  // ── Actions for the open message ─────────────────────────────────────────
  const [actions, setActions]         = useState<EmailAction[]>([])
  const [actionsLoading, setActionsLoading] = useState(false)

  // ── Creation success notices ──────────────────────────────────────────────
  const [notices, setNotices] = useState<{ label: string; href: string }[]>([])

  // ── Task form state ──────────────────────────────────────────────────────
  const [taskTitle,    setTaskTitle]    = useState('')
  const [taskDesc,     setTaskDesc]     = useState('')
  const [taskOwner,    setTaskOwner]    = useState(currentUserId)
  const [taskProject,  setTaskProject]  = useState('')
  const [taskPriority, setTaskPriority] = useState<1|2|3|4>(2)
  const [taskStatus,   setTaskStatus]   = useState<string>('open')
  const [taskDueAt,    setTaskDueAt]    = useState('')

  // ── Meeting form state ───────────────────────────────────────────────────
  const [meetingTitle,    setMeetingTitle]    = useState('')
  const [meetingStart,    setMeetingStart]    = useState('')
  const [meetingEnd,      setMeetingEnd]      = useState('')
  const [meetingLocation, setMeetingLocation] = useState('')
  const [meetingContext,  setMeetingContext]  = useState('')

  // ── Waiting-on form state ────────────────────────────────────────────────
  const [woTitle,       setWoTitle]       = useState('')
  const [woUseExternal, setWoUseExternal] = useState(true)
  const [woForUserId,   setWoForUserId]   = useState('')
  const [woForName,     setWoForName]     = useState('')
  const [woOwner,       setWoOwner]       = useState(currentUserId)
  const [woProject,     setWoProject]     = useState('')
  const [woDueAt,       setWoDueAt]       = useState('')
  const [woNotes,       setWoNotes]       = useState('')

  // ── Shared submission state ──────────────────────────────────────────────
  const [saving,    setSaving]    = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // ── Email intelligence ────────────────────────────────────────────────────
  type AnalysisState = 'idle' | 'analysing' | 'done' | 'error'
  const [analysisState,       setAnalysisState]       = useState<AnalysisState>('idle')
  const [analysisSuggestions, setAnalysisSuggestions] = useState<EmailAnalysisOutput | null>(null)
  const [analysisError,       setAnalysisError]       = useState<string | null>(null)

  // ── Link picker state ─────────────────────────────────────────────────────
  const [linking, setLinking] = useState(false)

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
    setNotices([])
    setActions([])
    setAnalysisState('idle')
    setAnalysisSuggestions(null)
    setAnalysisError(null)
    setBodyLoading(true)
    setActionsLoading(true)

    const [bodyRes, actionsRes] = await Promise.all([
      fetch(`/api/gmail/message/${msg.messageId}`).then((r) => r.ok ? r.json() : null),
      getMessageActions(msg.messageId),
    ])

    setBodyLoading(false)
    setActionsLoading(false)

    if (bodyRes) {
      setBody(bodyRes.body ?? '')
      setDeadlineHint(bodyRes.deadline ?? null)
    } else {
      setBody('')
    }

    const newActions = actionsRes.data ?? []
    setActions(newActions)
    if (newActions.length > 0) {
      setActionedIds((prev) => new Set([...prev, msg.messageId]))
    }
  }

  // ── Reload actions after a change ─────────────────────────────────────────

  async function refreshActions(messageId: string) {
    const result = await getMessageActions(messageId)
    const newActions = result.data ?? []
    setActions(newActions)
    if (newActions.length > 0) {
      setActionedIds((prev) => new Set([...prev, messageId]))
    } else {
      setActionedIds((prev) => {
        const next = new Set(prev)
        next.delete(messageId)
        return next
      })
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
    setTaskDueAt(deadlineHint?.dueDate ? toDatetimeLocal(deadlineHint.dueDate) : '')
    setFormError(null)
  }

  function openWoForm() {
    setCreateMode('waiting-on')
    setWoTitle(selected?.subject ?? '')
    setWoUseExternal(true)
    setWoForUserId('')
    setWoForName(selected ? senderName(selected.from) : '')
    setWoOwner(currentUserId)
    setWoProject('')
    setWoDueAt(deadlineHint?.dueDate ? toDatetimeLocal(deadlineHint.dueDate) : '')
    setWoNotes('')
    setFormError(null)
  }

  function openMeetingForm(suggestion: MeetingSuggestion) {
    setCreateMode('meeting')
    setMeetingTitle(suggestion.title)
    setMeetingStart(suggestion.scheduled_start ? utcToWall(suggestion.scheduled_start) : '')
    setMeetingEnd(suggestion.scheduled_end ? utcToWall(suggestion.scheduled_end) : '')
    setMeetingLocation(suggestion.location ?? '')
    // Derive context from reason + evidence so the user has useful prep notes
    const contextParts = [suggestion.reason]
    if (suggestion.evidence) contextParts.push(`"${suggestion.evidence}"`)
    setMeetingContext(contextParts.join('\n\n'))
    setFormError(null)
  }

  // ── Submission handlers ───────────────────────────────────────────────────

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault()
    if (!selected || !taskTitle.trim() || saving) return
    setSaving(true)
    setFormError(null)
    const result = await createTaskFromEmail(selected.messageId, {
      title:         taskTitle.trim(),
      description:   taskDesc.trim() || undefined,
      owner_user_id: taskOwner || undefined,
      project_id:    taskProject || undefined,
      priority:      taskPriority,
      status:        taskStatus as 'proposed' | 'open' | 'in_progress' | 'blocked',
      due_at:        taskDueAt || undefined,
    })
    setSaving(false)
    if (result.error) {
      setFormError(result.error)
    } else {
      setCreateMode(null)
      setNotices((prev) => [...prev, { label: `Task: ${taskTitle.trim()}`, href: `/tasks/${result.data!.id}` }])
      setActionedIds((prev) => new Set([...prev, selected.messageId]))
      await refreshActions(selected.messageId)
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
      setCreateMode(null)
      setNotices((prev) => [...prev, { label: `Waiting on: ${woTitle.trim()}`, href: `/waiting-ons/${result.data!.id}` }])
      setActionedIds((prev) => new Set([...prev, selected.messageId]))
      await refreshActions(selected.messageId)
    }
  }

  async function handleCreateMeeting(e: React.FormEvent) {
    e.preventDefault()
    if (!selected || !meetingTitle.trim() || saving) return
    setSaving(true)
    setFormError(null)
    const result = await createMeetingFromEmail(selected.messageId, {
      title:           meetingTitle.trim(),
      scheduled_start: meetingStart || undefined,
      scheduled_end:   meetingEnd || undefined,
      location:        meetingLocation.trim() || undefined,
      context:         meetingContext.trim() || undefined,
    })
    setSaving(false)
    if (result.error) {
      setFormError(result.error)
    } else {
      setCreateMode(null)
      setNotices((prev) => [...prev, { label: `Meeting: ${meetingTitle.trim()}`, href: `/meetings/${result.data!.id}` }])
      setActionedIds((prev) => new Set([...prev, selected.messageId]))
      await refreshActions(selected.messageId)
    }
  }

  // ── Link handlers ─────────────────────────────────────────────────────────

  async function handleLink(
    entityType: 'project' | 'meeting' | 'employee' | 'location',
    entityId: string,
  ) {
    if (!selected || !entityId || linking) return
    setLinking(true)
    const result = await linkEmailToEntity(
      selected.messageId,
      { subject: selected.subject, from: selected.from, date: selected.date, threadId: selected.threadId },
      entityType,
      entityId,
    )
    setLinking(false)
    if (!result.error) {
      await refreshActions(selected.messageId)
    }
  }

  async function handleUnlink(entitySourceId: string) {
    if (!selected) return
    await unlinkEmailFromEntity(entitySourceId)
    await refreshActions(selected.messageId)
  }

  // ── Email intelligence handler ────────────────────────────────────────────

  async function handleAnalyse() {
    if (!selected || analysisState === 'analysing') return
    setAnalysisState('analysing')
    setAnalysisSuggestions(null)
    setAnalysisError(null)
    const result = await analyzeEmailForSuggestions(selected.messageId)
    if (result.error) {
      setAnalysisError(result.error)
      setAnalysisState('error')
    } else {
      setAnalysisSuggestions(result.data!)
      setAnalysisState('done')
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

  // ── Derived: which entity IDs are already linked for the open message ──────
  const linkedEntityIds = new Set(actions.map((a) => a.entityId))

  // ── Main layout ───────────────────────────────────────────────────────────

  return (
    <div className="flex gap-4" style={{ minHeight: '60vh' }}>

      {/* ── Message list ─────────────────────────────────────────── */}
      <div className="w-[400px] shrink-0 bg-kk-panel border border-kk-line rounded-2xl overflow-hidden flex flex-col">
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
                <div className="flex items-center gap-1.5 shrink-0">
                  {actionedIds.has(msg.messageId) && (
                    <span className="w-1.5 h-1.5 rounded-full bg-kk-good" title="Actioned" />
                  )}
                  <span className="text-xs text-kk-muted">{formatDate(msg.date)}</span>
                </div>
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
      <div className="flex-1 min-w-0 bg-kk-panel border border-kk-line rounded-2xl flex flex-col">
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
            <div className="px-5 py-4 overflow-y-auto flex-1 max-h-48">
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

            {/* ── Actions area ─────────────────────────────────────── */}
            <div className="border-t border-kk-line overflow-y-auto max-h-[55vh] shrink-0">

              {/* ── Notices (created entities) ─────────────────────── */}
              {notices.length > 0 && (
                <div className="px-5 pt-3 space-y-1">
                  {notices.map((n, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-kk-good shrink-0" />
                      <Link
                        href={n.href}
                        className="text-xs text-kk-good underline hover:opacity-80 transition-opacity"
                      >
                        {n.label}
                      </Link>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Task creation form ─────────────────────────────── */}
              {createMode === 'task' && (
                <form onSubmit={handleCreateTask} className="px-5 py-4 space-y-3">
                  <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide">New task from email</div>

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

                  <div className="grid grid-cols-2 gap-3">
                    {canAssign ? (
                      <div>
                        <label className="block text-xs font-medium text-kk-ink mb-1">Responsible</label>
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
                <form onSubmit={handleCreateWo} className="px-5 py-4 space-y-3">
                  <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide">New waiting on from email</div>

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

              {/* ── Meeting creation form ──────────────────────────── */}
              {createMode === 'meeting' && (
                <form onSubmit={handleCreateMeeting} className="px-5 py-4 space-y-3">
                  <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide">New meeting from email</div>

                  <div>
                    <label className="block text-xs font-medium text-kk-ink mb-1">Title *</label>
                    <input
                      type="text"
                      value={meetingTitle}
                      onChange={(e) => setMeetingTitle(e.target.value)}
                      required
                      maxLength={500}
                      disabled={saving}
                      className={field}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-kk-ink mb-1">
                        Start <span className="text-kk-muted font-normal">(optional)</span>
                      </label>
                      <input
                        type="datetime-local"
                        value={meetingStart}
                        onChange={(e) => setMeetingStart(e.target.value)}
                        disabled={saving}
                        className={field}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-kk-ink mb-1">
                        End <span className="text-kk-muted font-normal">(optional)</span>
                      </label>
                      <input
                        type="datetime-local"
                        value={meetingEnd}
                        onChange={(e) => setMeetingEnd(e.target.value)}
                        disabled={saving}
                        className={field}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-kk-ink mb-1">
                      Location <span className="text-kk-muted font-normal">(optional)</span>
                    </label>
                    <input
                      type="text"
                      value={meetingLocation}
                      onChange={(e) => setMeetingLocation(e.target.value)}
                      maxLength={500}
                      disabled={saving}
                      className={field}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-kk-ink mb-1">
                      Context / prep notes <span className="text-kk-muted font-normal">(optional)</span>
                    </label>
                    <textarea
                      value={meetingContext}
                      onChange={(e) => setMeetingContext(e.target.value)}
                      rows={3}
                      disabled={saving}
                      className={`${field} resize-none`}
                    />
                  </div>

                  {formError && <p className="text-xs text-kk-bad">{formError}</p>}

                  <div className="flex gap-2 pt-1">
                    <button
                      type="submit"
                      disabled={!meetingTitle.trim() || saving}
                      className="px-4 py-1.5 bg-kk-ink text-white text-xs font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
                    >
                      {saving ? 'Creating…' : 'Create meeting'}
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

              {/* ── Action buttons + link pickers (when no form open) ── */}
              {createMode === null && (
                <div className="px-5 py-4 space-y-4">

                  {/* Create buttons */}
                  <div className="flex gap-2">
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

                  {/* ── Email intelligence ──────────────────────────── */}
                  <div className="space-y-3" data-testid="email-intelligence">

                    {/* Trigger / status row */}
                    <div className="flex items-center gap-3">
                      {analysisState !== 'analysing' && (
                        <button
                          onClick={handleAnalyse}
                          data-testid="analyse-button"
                          className="px-3 py-1.5 border border-kk-line text-xs text-kk-muted rounded-xl hover:bg-kk-soft hover:text-kk-ink transition-colors"
                        >
                          {analysisState === 'done'  ? 'Re-analyse' :
                           analysisState === 'error' ? 'Retry' :
                                                       'Analyse email'}
                        </button>
                      )}
                      {analysisState === 'analysing' && (
                        <span className="text-xs text-kk-muted" data-testid="analysing-state">
                          Analysing…
                        </span>
                      )}
                    </div>

                    {/* Error state */}
                    {analysisState === 'error' && analysisError && (
                      <div className="space-y-1" data-testid="analysis-error">
                        <p className="text-xs text-kk-bad">{analysisError}</p>
                      </div>
                    )}

                    {/* Results */}
                    {analysisState === 'done' && analysisSuggestions && (
                      <div className="space-y-2" data-testid="analysis-results">
                        <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide">
                          Kockpit suggests
                        </div>

                        {analysisSuggestions.suggestions.length === 0 ? (
                          <div data-testid="no-suggestions">
                            <p className="text-xs text-kk-muted italic">No clear actions found.</p>
                            {analysisSuggestions.analysis_note && (
                              <p className="text-xs text-kk-muted mt-1">{analysisSuggestions.analysis_note}</p>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {analysisSuggestions.suggestions.map((s, i) => (
                              <SuggestionCard key={i} suggestion={s} onReviewMeeting={openMeetingForm} />
                            ))}
                            {analysisSuggestions.analysis_note && (
                              <p className="text-xs text-kk-muted">{analysisSuggestions.analysis_note}</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Link pickers */}
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide">Link to</div>

                    <div className="grid grid-cols-2 gap-2">
                      {/* Project picker */}
                      {projects.length > 0 && (
                        <select
                          value=""
                          onChange={(e) => { if (e.target.value) handleLink('project', e.target.value) }}
                          disabled={linking}
                          className={`${field} bg-white`}
                        >
                          <option value="">Project…</option>
                          {projects
                            .filter((p) => !linkedEntityIds.has(p.id))
                            .map((p) => (
                              <option key={p.id} value={p.id}>{p.title}</option>
                            ))}
                        </select>
                      )}

                      {/* Meeting picker */}
                      {meetings.length > 0 && (
                        <select
                          value=""
                          onChange={(e) => { if (e.target.value) handleLink('meeting', e.target.value) }}
                          disabled={linking}
                          className={`${field} bg-white`}
                        >
                          <option value="">Meeting…</option>
                          {meetings
                            .filter((m) => !linkedEntityIds.has(m.id))
                            .map((m) => (
                              <option key={m.id} value={m.id}>{m.title}</option>
                            ))}
                        </select>
                      )}

                      {/* Person picker */}
                      {employees.length > 0 && (
                        <select
                          value=""
                          onChange={(e) => { if (e.target.value) handleLink('employee', e.target.value) }}
                          disabled={linking}
                          className={`${field} bg-white`}
                        >
                          <option value="">Person…</option>
                          {employees
                            .filter((e) => !linkedEntityIds.has(e.id))
                            .map((e) => (
                              <option key={e.id} value={e.id}>{e.name}</option>
                            ))}
                        </select>
                      )}

                      {/* Location picker */}
                      {locations.length > 0 && (
                        <select
                          value=""
                          onChange={(e) => { if (e.target.value) handleLink('location', e.target.value) }}
                          disabled={linking}
                          className={`${field} bg-white`}
                        >
                          <option value="">Location…</option>
                          {locations
                            .filter((l) => !linkedEntityIds.has(l.id))
                            .map((l) => (
                              <option key={l.id} value={l.id}>{l.name}</option>
                            ))}
                        </select>
                      )}
                    </div>
                  </div>

                  {/* Actions summary */}
                  {actionsLoading ? (
                    <p className="text-xs text-kk-muted">Loading actions…</p>
                  ) : actions.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide">Actions taken</div>
                      {actions.map((action) => (
                        <div key={action.entitySourceId} className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-xs text-kk-muted shrink-0">
                              {ENTITY_TYPE_LABEL[action.entityType] ?? action.entityType}:
                            </span>
                            <span className="text-xs text-kk-ink truncate">
                              {action.label ?? action.entityId}
                            </span>
                          </div>
                          {action.relation === 'related_to' && (
                            <button
                              onClick={() => handleUnlink(action.entitySourceId)}
                              className="text-xs text-kk-muted hover:text-kk-bad transition-colors shrink-0"
                            >
                              Unlink
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
