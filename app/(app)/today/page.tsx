import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import { canAccessManagementView, canAssignToOthers } from '@/lib/permissions'
import {
  getCopenhagenWeekBounds,
  copenhagenMidnightUTC,
  getDueState,
  sortWorkItems,
} from '@/lib/today/weekUtils'
import { sortOpenTodos, filterTodosForToday } from '@/lib/today/todoUtils'
import type { WorkItem } from '@/lib/today/weekUtils'
import type { ViewMode, Todo } from '@/lib/types'
import TodoBlock from '../todos/TodoBlock'
import CaptureBar from '@/components/layout/CaptureBar'
import { PriorityDot, PRIORITY_CONFIG } from '@/components/ui/PriorityDot'

export const dynamic = 'force-dynamic'

// ─── Due-state badge config ──────────────────────────────────────────────────

const DUE_STATE_CONFIG = {
  overdue:   { label: 'OVERDUE',  cls: 'text-white bg-[#AD3919]' },
  today:     { label: 'TODAY',    cls: 'text-kk-warn bg-kk-warn-bg' },
  tomorrow:  { label: 'TOMORROW', cls: 'text-kk-ink bg-kk-soft' },
  this_week: { label: '',         cls: '' },
  no_date:   { label: '',         cls: '' },
} as const

// ─── Raw row types ───────────────────────────────────────────────────────────

type RawTask = {
  id: string; title: string; priority: number; status: string
  due_at: string | null; completed_at: string | null
  owner_user_id: string | null; created_by_user_id: string | null
  owner: { id: string; display_name: string } | Array<{ id: string; display_name: string }> | undefined
}

type RawWO = {
  id: string; title: string; priority: number
  due_at: string | null; fulfilled_at: string | null
  owner_user_id: string | null; waiting_for_name: string | null
  waiting_for_user?: { id: string; display_name: string } | Array<{ id: string; display_name: string }> | undefined
}

type RawMeeting = {
  id: string; title: string; status: string
  scheduled_start: string | null
}

// ─── Display helpers ─────────────────────────────────────────────────────────

function ownerName(raw: RawTask | RawWO): string | undefined {
  const o = (raw as RawTask).owner
  if (!o) return undefined
  return (Array.isArray(o) ? o[0] : o)?.display_name
}

function waitingForDisplay(wo: RawWO): string {
  if (wo.waiting_for_user) {
    const u = Array.isArray(wo.waiting_for_user) ? wo.waiting_for_user[0] : wo.waiting_for_user
    if (u?.display_name) return u.display_name
  }
  return wo.waiting_for_name ?? '—'
}

function formatTime(dt: string | null): string | null {
  if (!dt) return null
  return new Date(dt).toLocaleTimeString('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit' })
}

function formatMeetingDate(dt: string): { day: string; date: string } {
  const d = new Date(dt)
  const day = d.toLocaleDateString('en-GB', { timeZone: 'Europe/Copenhagen', weekday: 'short' })
  const date = d.toLocaleDateString('en-GB', { timeZone: 'Europe/Copenhagen', day: 'numeric', month: 'short' })
  return { day, date }
}

// ─── UI micro-components ─────────────────────────────────────────────────────

function EmptyRow({ text }: { text: string }) {
  return <div className="px-5 py-4 text-sm text-kk-muted text-center">{text}</div>
}

function ThreeDots() {
  return (
    <span className="text-kk-muted/40 shrink-0">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="8" cy="13" r="1.2"/></svg>
    </span>
  )
}

// ─── Card header icons ────────────────────────────────────────────────────────

function IconUrgent() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2L9.5 7H14L10.5 10l1.5 5L8 12l-4 3 1.5-5L2 7h4.5L8 2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
    </svg>
  )
}
function IconWorkWeek() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M5 1v3M11 1v3M1.5 6.5h13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  )
}
function IconWaiting() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M8 4.5V8l2.5 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function IconMeeting() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1" y="3" width="10" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M11 6.5l4-2v7l-4-2V6.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
    </svg>
  )
}

// ─── Section header icons (Work this week groups) ────────────────────────────

function IconClock() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M8 4.5V8l2 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function IconCheckSquare() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function IconArrowIn() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function IconReturn() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8h8a3 3 0 000-6H7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M5.5 5.5L3 8l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ─── Soft panel shell ────────────────────────────────────────────────────────

function Panel({
  title, badge, footerHref, footerLabel, children, icon,
}: {
  title: string
  badge?: number
  footerHref?: string
  footerLabel?: string
  children: React.ReactNode
  icon?: React.ReactNode
}) {
  return (
    <div className="bg-white border border-kk-line rounded-xl overflow-hidden shadow-sm">
      <div className="px-5 py-3 border-b border-kk-line flex items-center justify-between">
        <h2 className="text-base font-bold text-kk-ink flex items-center gap-2">
          {icon && <span className="text-kk-muted shrink-0">{icon}</span>}
          {title}
          {badge !== undefined && badge > 0 && (
            <span className="text-kk-muted font-normal text-sm">· {badge} items</span>
          )}
        </h2>
      </div>
      <div>{children}</div>
      {footerHref && footerLabel && (
        <div className="px-5 py-2 border-t border-kk-line flex justify-end">
          <Link href={footerHref} className="text-xs text-kk-muted font-medium hover:text-kk-ink transition-colors">
            {footerLabel} →
          </Link>
        </div>
      )}
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const [user, params, allActiveUsers] = await Promise.all([getCurrentUser(), searchParams, getActiveUsers()])
  if (!user) return null

  const view = (params.view || (canAccessManagementView(user.role) ? 'management' : 'personal')) as ViewMode
  const canManage = canAccessManagementView(user.role)
  const isManagementView = view === 'management' && canManage

  const supabase = await createClient()
  const now = new Date()
  const { weekStart, weekEnd } = getCopenhagenWeekBounds(now)
  const weekStartISO = weekStart.toISOString()
  const weekEndISO   = weekEnd.toISOString()

  const todayDateStr  = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Copenhagen' })
  const [ty, tm, td]  = todayDateStr.split('-').map(Number)
  const todayStart    = copenhagenMidnightUTC(ty, tm, td)
  const todayEnd      = copenhagenMidnightUTC(ty, tm, td + 1)
  const todayStartISO = todayStart.toISOString()
  const todayEndISO   = todayEnd.toISOString()

  // All reads fire in parallel
  const [
    unfinishedTasksRes,
    allOpenWOsRes,
    todayMeetingsRes,
    weekMeetingsRes,
    draftMeetingsRes,
    openTodosRes,
    pendingReviewTasksRes,
    returnedTasksRes,
    expectedSubmissionsRes,
    activeProjectsRes,
  ] = await Promise.all([

    // Unfinished tasks: overdue OR due this week
    (isManagementView
      ? supabase.from('tasks')
          .select('id, title, priority, status, due_at, completed_at, owner_user_id, created_by_user_id, owner:owner_user_id (id, display_name)')
          .lt('due_at', weekEndISO).not('due_at', 'is', null).not('status', 'in', '("done","cancelled")').is('archived_at', null)
      : supabase.from('tasks')
          .select('id, title, priority, status, due_at, completed_at, owner_user_id, created_by_user_id, owner:owner_user_id (id, display_name)')
          .eq('owner_user_id', user.id).lt('due_at', weekEndISO).not('due_at', 'is', null).not('status', 'in', '("done","cancelled")').is('archived_at', null)
    ),

    // All open waiting ons
    (isManagementView
      ? supabase.from('waiting_ons')
          .select('id, title, priority, due_at, fulfilled_at, owner_user_id, waiting_for_name, waiting_for_user:waiting_for_user_id (id, display_name)')
          .eq('status', 'open').is('archived_at', null).order('priority', { ascending: true }).order('due_at', { ascending: true, nullsFirst: false }).limit(30)
      : supabase.from('waiting_ons')
          .select('id, title, priority, due_at, fulfilled_at, owner_user_id, waiting_for_name, waiting_for_user:waiting_for_user_id (id, display_name)')
          .eq('owner_user_id', user.id).eq('status', 'open').is('archived_at', null).order('priority', { ascending: true }).order('due_at', { ascending: true, nullsFirst: false }).limit(30)
    ),

    // Today's meetings
    supabase.from('meetings').select('id, title, status, scheduled_start')
      .in('status', ['scheduled', 'open']).gte('scheduled_start', todayStartISO).lt('scheduled_start', todayEndISO).order('scheduled_start'),

    // All meetings this week
    supabase.from('meetings').select('id, title, status, scheduled_start')
      .in('status', ['scheduled', 'open']).gte('scheduled_start', weekStartISO).lt('scheduled_start', weekEndISO).order('scheduled_start'),

    // Draft meetings
    canManage
      ? supabase.from('meetings').select('id, title, status, scheduled_start').eq('status', 'draft').order('scheduled_start', { ascending: false }).limit(5)
      : Promise.resolve({ data: [] as RawMeeting[] }),

    // Open todos
    supabase.from('todos')
      .select('id, user_id, title, priority, created_at, updated_at, completed_at, cancelled_at, notes, scheduled_for, recurrence_rule, recurrence_day, parent_todo_id, upgraded_to_task_id, upgraded_at, completion_context, completed_by_user_id, sort_order')
      .eq('user_id', user.id).is('completed_at', null).is('cancelled_at', null).is('upgraded_to_task_id', null)
      .or(`recurrence_rule.is.null,scheduled_for.lte.${todayDateStr}`)
      .order('sort_order', { ascending: true, nullsFirst: true }).order('created_at', { ascending: false }).limit(50),

    // Tasks pending my review
    supabase.from('tasks')
      .select('id, title, priority, due_at, submitted_at, status, owner:owner_user_id (id, display_name)')
      .eq('created_by_user_id', user.id).eq('status', 'pending_review').is('archived_at', null)
      .order('submitted_at', { ascending: true }).limit(20),

    // Tasks returned to me
    supabase.from('tasks')
      .select('id, title, priority, due_at, returned_at, latest_review_note, status, creator:created_by_user_id (id, display_name)')
      .eq('owner_user_id', user.id).not('returned_at', 'is', null).not('status', 'in', '("done","cancelled","pending_review")').is('archived_at', null)
      .order('returned_at', { ascending: false }).limit(20),

    // Tasks expected to be submitted to me this week
    supabase.from('tasks')
      .select('id, title, priority, due_at, status, owner:owner_user_id (id, display_name)')
      .eq('created_by_user_id', user.id).neq('owner_user_id', user.id)
      .gte('due_at', weekStartISO).lt('due_at', weekEndISO)
      .not('status', 'in', '("done","cancelled","pending_review")').is('archived_at', null)
      .order('due_at', { ascending: true }).limit(20),

    // Active projects
    supabase.from('projects').select('id, title').is('archived_at', null).not('status', 'eq', 'completed').order('title'),
  ])

  // ─── Build work items for urgent classification ──────────────────────────

  const unfinishedTasks = (unfinishedTasksRes.data || []) as RawTask[]
  const allOpenWOs      = (allOpenWOsRes.data       || []) as RawWO[]
  const draftMeetings   = (draftMeetingsRes.data    || []) as RawMeeting[]

  const wosForWork = allOpenWOs.filter(w => w.due_at && new Date(w.due_at) < weekEnd)

  const workItems: WorkItem[] = [
    ...unfinishedTasks.map(t => ({
      id: t.id, kind: 'task' as const, title: t.title, priority: t.priority,
      due_at: t.due_at, done_at: null, href: `/tasks/${t.id}?returnTo=/today`,
      ownerName: isManagementView ? ownerName(t) : undefined,
    })),
    ...wosForWork.map(w => ({
      id: w.id, kind: 'waiting_on' as const, title: w.title, priority: w.priority,
      due_at: w.due_at, done_at: null, href: `/waiting-ons/${w.id}`,
      ownerName: isManagementView ? ownerName(w) : undefined,
    })),
  ]

  const unfinished = sortWorkItems(workItems, now)

  // ─── Urgent: overdue, today, or tomorrow ─────────────────────────────────

  const urgentItems = unfinished.filter(item => {
    const s = getDueState(item.due_at, now, weekEnd)
    return s === 'overdue' || s === 'today' || s === 'tomorrow'
  })
  const urgentIds = new Set(urgentItems.map(i => i.id))
  const nonUrgentWOs = allOpenWOs.filter(wo => !urgentIds.has(wo.id))

  // ─── Work this week — grouped sections ─────────────────────────────────

  type RawPendingReview = {
    id: string; title: string; priority: number; due_at: string | null; submitted_at: string | null; status: string
    owner: { id: string; display_name: string } | Array<{ id: string; display_name: string }> | undefined
  }
  type RawReturned = {
    id: string; title: string; priority: number; due_at: string | null; returned_at: string | null; latest_review_note: string | null; status: string
    creator: { id: string; display_name: string } | Array<{ id: string; display_name: string }> | undefined
  }
  type RawExpectedSubmission = {
    id: string; title: string; priority: number; due_at: string | null; status: string
    owner: { id: string; display_name: string } | Array<{ id: string; display_name: string }> | undefined
  }

  const pendingReviewTasks  = (!isManagementView ? (pendingReviewTasksRes.data || []) : []) as RawPendingReview[]
  const returnedTasks       = (!isManagementView ? (returnedTasksRes.data      || []) : []) as RawReturned[]
  const expectedSubmissions = (!isManagementView ? (expectedSubmissionsRes.data || []) : []) as RawExpectedSubmission[]

  // Deduplicate: a task should appear in only one group
  const pendingIds  = new Set(pendingReviewTasks.map(t => t.id))
  const returnedIds = new Set(returnedTasks.map(t => t.id))
  const expectedIds = new Set(expectedSubmissions.map(t => t.id))
  const assignedToMe = unfinishedTasks.filter(t =>
    t.owner_user_id === user.id && !urgentIds.has(t.id)
    && !pendingIds.has(t.id) && !returnedIds.has(t.id) && !expectedIds.has(t.id)
    && getDueState(t.due_at, now, weekEnd) === 'this_week'
  )
  const workWeekTotal = pendingReviewTasks.length + returnedTasks.length + assignedToMe.length + expectedSubmissions.length

  // ─── Meetings ─────────────────────────────────────────────────────────────

  const todayMeetings: RawMeeting[] = (todayMeetingsRes.data || []) as RawMeeting[]
  const todayMeetingIds = new Set(todayMeetings.map(m => m.id))
  const laterMeetings: RawMeeting[] = ((weekMeetingsRes.data || []) as RawMeeting[]).filter(m => !todayMeetingIds.has(m.id))
  const allMeetings = [...todayMeetings, ...laterMeetings, ...(canManage ? (draftMeetings as RawMeeting[]) : [])]
  const meetingsTotal = allMeetings.length

  // ─── Todos ────────────────────────────────────────────────────────────────

  const openTodos = sortOpenTodos(filterTodosForToday((openTodosRes.data ?? []) as Todo[], todayDateStr))
  const todoAllUsers = canAssignToOthers(user.role)
    ? allActiveUsers
    : [{ id: user.id, display_name: user.display_name, email: user.email }]
  const todoProjects = (activeProjectsRes.data ?? []) as { id: string; title: string }[]

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="-m-4 p-4 lg:p-6 min-h-screen bg-kk-bg">

      {/* Header */}
      <div className="flex items-end justify-between mb-4">
        <h1
          className="font-brand leading-none text-7xl lg:text-8xl font-black text-[#AD3919] tracking-tight [text-shadow:2px_3px_6px_rgba(0,0,0,0.15)]"
          style={{ WebkitTextStroke: '0.25px #171717' }}
        >
          KILLER KOCKPIT
        </h1>
        {canManage && (
          <div className="flex gap-1 text-sm">
            <Link href="/today?view=personal" className={`px-3 py-1.5 rounded-lg transition-colors ${view === 'personal' ? 'bg-kk-ink text-white font-semibold' : 'text-kk-muted hover:bg-kk-soft hover:text-kk-ink'}`}>Personal</Link>
            <Link href="/today?view=management" className={`px-3 py-1.5 rounded-lg transition-colors ${view === 'management' ? 'bg-kk-ink text-white font-semibold' : 'text-kk-muted hover:bg-kk-soft hover:text-kk-ink'}`}>Management</Link>
          </div>
        )}
      </div>

      <div className="mb-5"><CaptureBar user={user} inline /></div>

      {/* ═══ My To-Dos — full width, main panel ═══════════════════════════════ */}
      <div className="mb-5">
        <TodoBlock
          openTodos={openTodos} completedThisWeek={[]}
          maxItems={12} showFooter softPanel
          allUsers={todoAllUsers} projects={todoProjects} currentUserId={user.id}
        />
      </div>

      {/* ═══ Two-column: Work left, Waiting+Meetings right ════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4 items-start">

        {/* Left column */}
        <div className="space-y-4 order-2 lg:order-none">

          {/* Urgent Now — conditional */}
          {urgentItems.length > 0 && (
            <Panel title="Urgent now" badge={urgentItems.length} footerHref="/tasks" footerLabel={urgentItems.length > 5 ? `View all ${urgentItems.length} urgent items` : 'View all tasks'} icon={<IconUrgent />}>
              <div className="divide-y divide-kk-line/60">
                {urgentItems.slice(0, 5).map(item => {
                  const s = getDueState(item.due_at, now, weekEnd)
                  const cfg = DUE_STATE_CONFIG[s]
                  return (
                    <Link key={item.id} href={item.href} className="flex items-center gap-3 px-5 py-2.5 hover:bg-kk-bg/60 transition-colors group">
                      <PriorityDot priority={item.priority} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm text-kk-ink group-hover:underline truncate block">{item.title}</span>
                        {item.ownerName && <div className="text-xs text-kk-muted mt-0.5 truncate">{item.ownerName}</div>}
                      </div>
                      {cfg.label && <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${cfg.cls}`}>{cfg.label}</span>}
                    </Link>
                  )
                })}
              </div>
            </Panel>
          )}

          {/* Work this week */}
          <Panel title="Work this week" badge={workWeekTotal} footerHref="/tasks" footerLabel="View all tasks" icon={<IconWorkWeek />}>
            {workWeekTotal === 0 ? (
              <EmptyRow text="No tasks this week." />
            ) : (
              <div>
                {/* Waiting for my review */}
                {pendingReviewTasks.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 px-5 py-1.5 bg-[#f7eedf] text-sm font-semibold text-kk-ink">
                      <span className="text-kk-warn"><IconClock /></span>
                      Waiting for my review
                      <span className="text-kk-muted font-normal">· {pendingReviewTasks.length}</span>
                    </div>
                    <div className="divide-y divide-kk-line/60">
                      {pendingReviewTasks.map(t => {
                        const o = Array.isArray(t.owner) ? t.owner[0] : t.owner
                        return (
                          <Link key={t.id} href={`/tasks/${t.id}?returnTo=/today`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-kk-bg/60 transition-colors group">
                            <div className="w-[18px] h-[18px] rounded-[3px] border border-[#c5bfb4] bg-white shrink-0" />
                            <PriorityDot priority={t.priority} />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm text-kk-ink group-hover:underline truncate block">{t.title}</span>
                              {o?.display_name && <div className="text-xs text-kk-muted mt-0.5">Waiting on: {o.display_name}</div>}
                            </div>
                            <span className="text-xs text-kk-muted shrink-0">{PRIORITY_CONFIG[t.priority]?.label}</span>
                            <ThreeDots />
                          </Link>
                        )
                      })}
                    </div>
                  </>
                )}

                {/* Returned to you */}
                {returnedTasks.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 px-5 py-1.5 bg-[#fce8e6] text-sm font-semibold text-kk-ink">
                      <span className="text-[#AD3919]"><IconReturn /></span>
                      Returned to you
                      <span className="text-kk-muted font-normal">· {returnedTasks.length}</span>
                    </div>
                    <div className="divide-y divide-kk-line/60">
                      {returnedTasks.map(t => {
                        const c = Array.isArray(t.creator) ? t.creator[0] : t.creator
                        return (
                          <Link key={t.id} href={`/tasks/${t.id}?returnTo=/today`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-kk-bg/60 transition-colors group">
                            <div className="w-[18px] h-[18px] rounded-[3px] border border-[#c5bfb4] bg-white shrink-0" />
                            <PriorityDot priority={t.priority} />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm text-kk-ink group-hover:underline truncate block">{t.title}</span>
                              {t.latest_review_note ? <div className="text-xs text-kk-muted mt-0.5 truncate">{t.latest_review_note}</div>
                                : c?.display_name ? <div className="text-xs text-kk-muted mt-0.5">From: {c.display_name}</div> : null}
                            </div>
                            <span className="text-xs text-kk-muted shrink-0">{PRIORITY_CONFIG[t.priority]?.label}</span>
                            <ThreeDots />
                          </Link>
                        )
                      })}
                    </div>
                  </>
                )}

                {/* Assigned to me */}
                {assignedToMe.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 px-5 py-1.5 bg-[#e0ecf5] text-sm font-semibold text-kk-ink">
                      <span className="text-[#3b6fa0]"><IconCheckSquare /></span>
                      Assigned to me
                      <span className="text-kk-muted font-normal">· {assignedToMe.length}</span>
                    </div>
                    <div className="divide-y divide-kk-line/60">
                      {assignedToMe.slice(0, 7).map(t => (
                        <Link key={t.id} href={`/tasks/${t.id}?returnTo=/today`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-kk-bg/60 transition-colors group">
                          <div className="w-[18px] h-[18px] rounded-[3px] border border-[#c5bfb4] bg-white shrink-0" />
                          <PriorityDot priority={t.priority} />
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-kk-ink group-hover:underline truncate block">{t.title}</span>
                          </div>
                          <span className="text-xs text-kk-muted shrink-0">{PRIORITY_CONFIG[t.priority]?.label}</span>
                          <ThreeDots />
                        </Link>
                      ))}
                      {assignedToMe.length > 7 && <div className="px-5 py-2 text-xs text-kk-muted">+ {assignedToMe.length - 7} more</div>}
                    </div>
                  </>
                )}

                {/* Coming my way */}
                {expectedSubmissions.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 px-5 py-1.5 bg-[#fce4d6] text-sm font-semibold text-kk-ink">
                      <span className="text-[#a0603b]"><IconArrowIn /></span>
                      Coming my way
                      <span className="text-kk-muted font-normal">· {expectedSubmissions.length}</span>
                    </div>
                    <div className="divide-y divide-kk-line/60">
                      {expectedSubmissions.slice(0, 5).map(t => {
                        const o = Array.isArray(t.owner) ? t.owner[0] : t.owner
                        return (
                          <Link key={t.id} href={`/tasks/${t.id}?returnTo=/today`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-kk-bg/60 transition-colors group">
                            <div className="w-[18px] h-[18px] rounded-[3px] border border-[#c5bfb4] bg-white shrink-0" />
                            <PriorityDot priority={t.priority} />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm text-kk-ink group-hover:underline truncate block">{t.title}</span>
                              {o?.display_name && <div className="text-xs text-kk-muted mt-0.5">Waiting on: {o.display_name}</div>}
                            </div>
                            <span className="text-xs text-kk-muted shrink-0">{PRIORITY_CONFIG[t.priority]?.label}</span>
                            <ThreeDots />
                          </Link>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </Panel>
        </div>

        {/* Right column */}
        <div className="space-y-4 order-1 lg:order-none">

          {/* Waiting Ons */}
          <Panel title="Waiting ons" badge={nonUrgentWOs.length} footerHref="/waiting-ons" footerLabel="View all waiting ons" icon={<IconWaiting />}>
            {nonUrgentWOs.length === 0 ? (
              <EmptyRow text="No open waiting ons." />
            ) : (
              <div className="divide-y divide-kk-line/60">
                {nonUrgentWOs.slice(0, 5).map(wo => (
                  <Link key={wo.id} href={`/waiting-ons/${wo.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-kk-bg/60 transition-colors group">
                    <PriorityDot priority={wo.priority} />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-kk-ink group-hover:underline truncate block font-medium">{wo.title}</span>
                      <div className="text-xs text-kk-muted mt-0.5 truncate">Waiting on: {waitingForDisplay(wo)}</div>
                    </div>
                    <span className="text-xs text-kk-muted shrink-0">{PRIORITY_CONFIG[wo.priority]?.label}</span>
                    <ThreeDots />
                  </Link>
                ))}
                {nonUrgentWOs.length > 5 && <div className="px-5 py-2 text-xs text-kk-muted">+ {nonUrgentWOs.length - 5} more</div>}
              </div>
            )}
          </Panel>

          {/* Meetings — calendar-style */}
          <Panel title="Meetings" badge={meetingsTotal} footerHref="/meetings" footerLabel="View all meetings" icon={<IconMeeting />}>
            {allMeetings.length === 0 ? (
              <EmptyRow text="No meetings this week." />
            ) : (
              <div className="divide-y divide-kk-line/60">
                {allMeetings.slice(0, 7).map(m => {
                  const md = m.scheduled_start ? formatMeetingDate(m.scheduled_start) : null
                  return (
                    <Link key={m.id} href={m.status === 'draft' ? `/meetings/${m.id}/publish` : `/meetings/${m.id}`} className="flex items-center hover:bg-kk-bg/60 transition-colors group">
                      <div className="w-16 shrink-0 py-2.5 text-center border-r border-kk-line/40 bg-kk-bg/30">
                        {md ? (<><div className="text-[10px] text-kk-muted leading-tight">{md.day}</div><div className="text-xs text-kk-ink font-medium leading-tight">{md.date}</div></>) : <div className="text-[10px] text-kk-muted">TBD</div>}
                      </div>
                      <div className="flex-1 min-w-0 px-3 py-2.5">
                        <span className="text-sm text-kk-ink group-hover:underline truncate block">{m.title}</span>
                      </div>
                      {m.status === 'draft' && <span className="text-xs text-kk-muted shrink-0 pr-2">Draft</span>}
                      <span className="pr-4"><ThreeDots /></span>
                    </Link>
                  )
                })}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}
