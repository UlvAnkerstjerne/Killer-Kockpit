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
import QuickAddTask from './QuickAddTask'
import QuickNewMeeting from './QuickNewMeeting'
import CaptureBar from '@/components/layout/CaptureBar'
import { PriorityDot, PRIORITY_CONFIG } from '@/components/ui/PriorityDot'

export const dynamic = 'force-dynamic'

// ─── Due-state badge config ──────────────────────────────────────────────────

const DUE_STATE_CONFIG = {
  overdue:   { label: 'OVERDUE',  cls: 'text-white bg-[#AD3919] [box-shadow:2px_2px_0_#555555]' },
  today:     { label: 'TODAY',    cls: 'text-kk-warn bg-kk-warn-bg [box-shadow:2px_2px_0_#555555]' },
  tomorrow:  { label: 'TOMORROW', cls: 'text-kraft-light bg-[#171717] [box-shadow:2px_2px_0_#555555]' },
  this_week: { label: '',         cls: '' },
  no_date:   { label: '',         cls: '' },
} as const

// ─── Raw row types ───────────────────────────────────────────────────────────

type RawTask = {
  id: string; title: string; priority: number
  due_at: string | null; completed_at: string | null
  owner_user_id: string | null
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

function formatShortDate(dt: string | null): string | null {
  if (!dt) return null
  return new Date(dt).toLocaleDateString('en-GB', {
    timeZone: 'Europe/Copenhagen', weekday: 'short', day: 'numeric', month: 'short',
  })
}

// ─── UI micro-components ─────────────────────────────────────────────────────

function TypeChip({ label, green }: { label: string; green?: boolean }) {
  return (
    <span className={`text-[10px] border rounded px-1 py-px shrink-0 ${green ? 'text-kk-good border-kk-good/40 bg-kk-good-bg/50' : 'text-kraft-light bg-[#171717] border-[#171717] [box-shadow:2px_2px_0_#555555]'}`}>
      {label}
    </span>
  )
}

function EmptyRow({ text }: { text: string }) {
  return <div className="px-4 py-2.5 text-sm text-kk-muted text-center">{text}</div>
}

// ─── Card header icons ────────────────────────────────────────────────────────

function IconUrgent() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2L9.5 7H14L10.5 10l1.5 5L8 12l-4 3 1.5-5L2 7h4.5L8 2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
    </svg>
  )
}
function IconWorkWeek() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M5 1v3M11 1v3M1.5 6.5h13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  )
}
function IconTodo() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.3"/>
      <rect x="2.5" y="9.5" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M9.5 4.5h4M9.5 11.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  )
}
function IconWaiting() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M8 4.5V8l2.5 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function IconMeeting() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1" y="3" width="10" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M11 6.5l4-2v7l-4-2V6.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
    </svg>
  )
}
function IconGlance() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 12h2V8H2v4zM7 12h2V5H7v7zM12 12h2V2h-2v10z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
    </svg>
  )
}
function IconReview() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M5.5 8.5l2 2 3-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function IconReturned() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8h8a3 3 0 000-6H7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M5.5 5.5L3 8l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ─── Dashboard card shell ────────────────────────────────────────────────────

function DashCard({
  title, badge, footerHref, footerLabel, children, icon, accentHeader, maxRows,
}: {
  title: string
  badge?: number | string
  footerHref?: string
  footerLabel?: string
  children: React.ReactNode
  icon?: React.ReactNode
  accentHeader?: boolean
  maxRows?: number
}) {
  return (
    <div className="bg-kraft-light border-2 border-[#171717] rounded-lg overflow-hidden [box-shadow:4px_4px_0_#555555] flex flex-col h-full">
      <div className="px-4 py-2 border-b-2 border-[#171717] flex items-center justify-between bg-kraft-brown shrink-0">
        <h2 className="text-sm font-bold text-kk-ink flex items-center gap-1.5">
          {icon && <span className="text-kk-ink/50 shrink-0">{icon}</span>}
          {title}
          {badge !== undefined && (
            <span className="text-kk-muted font-normal ml-1">· {badge}</span>
          )}
        </h2>
      </div>
      <div className={`flex-1 min-h-0 ${maxRows ? 'overflow-y-auto overscroll-contain' : ''}`} style={maxRows ? { maxHeight: `${maxRows * 38}px` } : undefined}>{children}</div>
      {footerHref && footerLabel && (
        <div className="px-4 py-1.5 border-t border-[#171717]/20 flex justify-end shrink-0">
          <Link href={footerHref} className="text-xs text-kk-ink font-medium hover:opacity-70 transition-opacity">
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
    activeProjectsRes,
  ] = await Promise.all([

    // Unfinished tasks: overdue OR due this week (not done/cancelled, not archived)
    (isManagementView
      ? supabase.from('tasks')
          .select('id, title, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name)')
          .lt('due_at', weekEndISO)
          .not('due_at', 'is', null)
          .not('status', 'in', '("done","cancelled")')
          .is('archived_at', null)
      : supabase.from('tasks')
          .select('id, title, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name)')
          .eq('owner_user_id', user.id)
          .lt('due_at', weekEndISO)
          .not('due_at', 'is', null)
          .not('status', 'in', '("done","cancelled")')
          .is('archived_at', null)
    ),

    // All open waiting ons — no date restriction (Waiting Ons card shows all, not just this week)
    (isManagementView
      ? supabase.from('waiting_ons')
          .select('id, title, priority, due_at, fulfilled_at, owner_user_id, waiting_for_name, waiting_for_user:waiting_for_user_id (id, display_name)')
          .eq('status', 'open')
          .is('archived_at', null)
          .order('priority', { ascending: true })
          .order('due_at', { ascending: true, nullsFirst: false })
          .limit(30)
      : supabase.from('waiting_ons')
          .select('id, title, priority, due_at, fulfilled_at, owner_user_id, waiting_for_name, waiting_for_user:waiting_for_user_id (id, display_name)')
          .eq('owner_user_id', user.id)
          .eq('status', 'open')
          .is('archived_at', null)
          .order('priority', { ascending: true })
          .order('due_at', { ascending: true, nullsFirst: false })
          .limit(30)
    ),

    // Today's meetings (scheduled + open)
    supabase.from('meetings')
      .select('id, title, status, scheduled_start')
      .in('status', ['scheduled', 'open'])
      .gte('scheduled_start', todayStartISO)
      .lt('scheduled_start', todayEndISO)
      .order('scheduled_start'),

    // All meetings this week (today + later)
    supabase.from('meetings')
      .select('id, title, status, scheduled_start')
      .in('status', ['scheduled', 'open'])
      .gte('scheduled_start', weekStartISO)
      .lt('scheduled_start', weekEndISO)
      .order('scheduled_start'),

    // Draft meetings awaiting review (management only)
    canManage
      ? supabase.from('meetings')
          .select('id, title, scheduled_start')
          .eq('status', 'draft')
          .order('scheduled_start', { ascending: false })
          .limit(5)
      : Promise.resolve({ data: [] as { id: string; title: string; scheduled_start: string | null }[] }),

    // Open todos (personal only — never aggregated by management view).
    // Recurrence filter: show non-recurring always; recurring only if scheduled_for ≤ today.
    // Upgraded todos are excluded — they now live as Tasks.
    // Ordering: sort_order ASC NULLS FIRST (manual order; null = new = top),
    //           then priority ASC, created_at DESC as tie-break fallback.
    supabase.from('todos')
      .select('id, user_id, title, priority, created_at, updated_at, completed_at, cancelled_at, notes, scheduled_for, recurrence_rule, recurrence_day, parent_todo_id, upgraded_to_task_id, upgraded_at, completion_context, completed_by_user_id, sort_order')
      .eq('user_id', user.id)
      .is('completed_at', null)
      .is('cancelled_at', null)
      .is('upgraded_to_task_id', null)
      .or(`recurrence_rule.is.null,scheduled_for.lte.${todayDateStr}`)
      .order('sort_order', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: false })
      .limit(50),

    // Tasks pending my review (I am the requester)
    supabase.from('tasks')
      .select('id, title, priority, submitted_at, owner:owner_user_id (id, display_name)')
      .eq('created_by_user_id', user.id)
      .eq('status', 'pending_review')
      .is('archived_at', null)
      .order('submitted_at', { ascending: true })
      .limit(20),

    // Tasks returned to me (I am the responsible person)
    supabase.from('tasks')
      .select('id, title, priority, returned_at, latest_review_note, creator:created_by_user_id (id, display_name)')
      .eq('owner_user_id', user.id)
      .not('returned_at', 'is', null)
      .not('status', 'in', '("done","cancelled","pending_review")')
      .is('archived_at', null)
      .order('returned_at', { ascending: false })
      .limit(20),

    // Active projects for the upgrade-to-task modal
    supabase.from('projects')
      .select('id, title')
      .is('archived_at', null)
      .not('status', 'eq', 'completed')
      .order('title'),
  ])

  // ─── Build unified work items list ────────────────────────────────────────

  const unfinishedTasks = (unfinishedTasksRes.data || []) as RawTask[]
  const allOpenWOs      = (allOpenWOsRes.data       || []) as RawWO[]
  const draftMeetings   = (draftMeetingsRes.data    || []) as { id: string; title: string; scheduled_start: string | null }[]

  // For the work items list, only include WOs due within this week
  // (preserves the original week-scoped work list behaviour)
  const wosForWork = allOpenWOs.filter(w => w.due_at && new Date(w.due_at) < weekEnd)

  const workItems: WorkItem[] = [
    ...unfinishedTasks.map(t => ({
      id: t.id, kind: 'task' as const,
      title: t.title, priority: t.priority,
      due_at: t.due_at, done_at: null,
      href: `/tasks/${t.id}?returnTo=/today`,
      ownerName: isManagementView ? ownerName(t) : undefined,
    })),
    ...wosForWork.map(w => ({
      id: w.id, kind: 'waiting_on' as const,
      title: w.title, priority: w.priority,
      due_at: w.due_at, done_at: null,
      href: `/waiting-ons/${w.id}`,
      ownerName: isManagementView ? ownerName(w) : undefined,
    })),
  ]

  const unfinished = sortWorkItems(workItems, now)

  // ─── Classify by urgency ──────────────────────────────────────────────────

  const urgentItems = unfinished.filter(item => {
    const s = getDueState(item.due_at, now, weekEnd)
    return s === 'overdue' || s === 'today' || s === 'tomorrow'
  })

  // Work This Week = non-urgent tasks only (WOs are shown in dedicated WOs card)
  const weekTaskItems = unfinished.filter(item => {
    return getDueState(item.due_at, now, weekEnd) === 'this_week' && item.kind === 'task'
  })

  // Waiting Ons card: all open WOs excluding the ones already in Urgent Now
  const urgentIds = new Set(urgentItems.map(i => i.id))
  const nonUrgentWOs = allOpenWOs.filter(wo => !urgentIds.has(wo.id))

  // ─── Meetings ─────────────────────────────────────────────────────────────

  const todayMeetings: RawMeeting[] = (todayMeetingsRes.data || []) as RawMeeting[]
  const todayIds = new Set(todayMeetings.map(m => m.id))
  const laterMeetings: RawMeeting[] = ((weekMeetingsRes.data || []) as RawMeeting[]).filter(m => !todayIds.has(m.id))

  // ─── Todos ────────────────────────────────────────────────────────────────

  const openTodos = sortOpenTodos(filterTodosForToday((openTodosRes.data ?? []) as Todo[], todayDateStr))

  // ─── Upgrade-to-task modal data (personal view only) ─────────────────────

  const todoAllUsers = canAssignToOthers(user.role)
    ? allActiveUsers
    : [{ id: user.id, display_name: user.display_name, email: user.email }]
  const todoProjects = (activeProjectsRes.data ?? []) as { id: string; title: string }[]

  // ─── Handoff review data (personal only) ─────────────────────────────────

  type RawPendingReview = {
    id: string; title: string; priority: number; submitted_at: string | null
    owner: { id: string; display_name: string } | Array<{ id: string; display_name: string }> | undefined
  }
  type RawReturned = {
    id: string; title: string; priority: number; returned_at: string | null; latest_review_note: string | null
    creator: { id: string; display_name: string } | Array<{ id: string; display_name: string }> | undefined
  }

  const pendingReviewTasks = (pendingReviewTasksRes.data || []) as RawPendingReview[]
  const returnedTasks      = (returnedTasksRes.data      || []) as RawReturned[]

  // ─── At-a-glance summary counts ──────────────────────────────────────────

  const meetingsThisWeek = todayMeetings.length + laterMeetings.length

  // ─── Render ───────────────────────────────────────────────────────────────
  //
  // Layout: 2-column CSS grid on desktop (lg+).
  //   Left column  (3fr): Urgent Now → Work This Week → Completed This Week
  //   Right column (2fr): To-Dos → Waiting Ons → Meetings → At a Glance
  //
  // Mobile (< lg): single column, visual order 1-7 via CSS `order-N`.
  //   Cards with explicit lg:col-start-N lg:row-start-N are placed by the
  //   grid on desktop; lg:order-none resets to DOM order for auto-placement.
  //   On mobile, the `lg:col-start-*` classes are inactive so all items
  //   auto-place to col 1, ordered by the `order-N` class.

  return (
    <div className="-m-4 p-4 min-h-screen bg-kraft-light">

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className="flex items-end justify-between -mx-4 px-4 -mt-4 pt-4 pb-3 mb-1.5 border-b border-[#171717]/20">
        <h1
          className="font-brand leading-none text-[13vw] sm:text-6xl lg:text-8xl font-black text-[#AD3919] tracking-tight [text-shadow:2px_3px_6px_rgba(0,0,0,0.25)]"
          style={{ WebkitTextStroke: '0.25px #171717' }}
        >
          KILLER KOCKPIT
        </h1>
        {canManage && (
          <div className="hidden lg:flex gap-1 text-sm">
            <Link
              href="/today?view=personal"
              className={`px-3 py-1.5 rounded-lg transition-colors ${view === 'personal' ? 'bg-[#171717] text-kraft-light font-semibold' : 'text-kk-muted hover:bg-[#B7A486]/25 hover:text-kk-ink'}`}
            >
              Personal
            </Link>
            <Link
              href="/today?view=management"
              className={`px-3 py-1.5 rounded-lg transition-colors ${view === 'management' ? 'bg-[#171717] text-kraft-light font-semibold' : 'text-kk-muted hover:bg-[#B7A486]/25 hover:text-kk-ink'}`}
            >
              Management
            </Link>
          </div>
        )}
      </div>

      {/* ── Inline capture buttons — desktop only ──────────────────────────── */}
      <div className="hidden lg:block mb-3">
        <CaptureBar user={user} inline />
      </div>

      {/* ── To-Dos — full width ─────────────────────────────────────────────── */}
      <div className="mb-2.5">
        <TodoBlock
          openTodos={openTodos}
          completedThisWeek={[]}
          maxItems={8}
          accentHeader
          allUsers={todoAllUsers}
          projects={todoProjects}
          currentUserId={user.id}
        />
      </div>

      {/* ── Mobile task queue — Management mode only, hidden on desktop ──── */}
      {isManagementView && (
        <div className="lg:hidden mb-2.5">
          <DashCard
            title="My tasks"
            badge={(unfinishedTasks.length + pendingReviewTasks.length + returnedTasks.length) > 0
              ? unfinishedTasks.length + pendingReviewTasks.length + returnedTasks.length
              : undefined}
            icon={<IconWorkWeek />}
            accentHeader
            maxRows={10}
          >
            <QuickAddTask />
            {unfinishedTasks.length === 0 && pendingReviewTasks.length === 0 && returnedTasks.length === 0 ? (
              <EmptyRow text="No tasks right now." />
            ) : (
              <div className="divide-y divide-[#171717]/15">
                {/* Review items first */}
                {pendingReviewTasks.map(t => {
                  const o = Array.isArray(t.owner) ? t.owner[0] : t.owner
                  return (
                    <Link
                      key={`review-${t.id}`}
                      href={`/tasks/${t.id}?returnTo=/today`}
                      className="flex items-center gap-3 px-4 py-2 hover:bg-[#B7A486]/25 transition-colors group"
                    >
                      <PriorityDot priority={t.priority} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">
                          {t.title}
                        </span>
                        {o?.display_name && (
                          <div className="text-xs text-kk-muted mt-0.5 truncate">From: {o.display_name}</div>
                        )}
                      </div>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 text-kk-brand bg-kk-bad-bg">
                        Review
                      </span>
                    </Link>
                  )
                })}
                {/* Returned items */}
                {returnedTasks.map(t => {
                  const c = Array.isArray(t.creator) ? t.creator[0] : t.creator
                  return (
                    <Link
                      key={`returned-${t.id}`}
                      href={`/tasks/${t.id}?returnTo=/today`}
                      className="flex items-center gap-3 px-4 py-2 hover:bg-[#B7A486]/25 transition-colors group"
                    >
                      <PriorityDot priority={t.priority} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">
                          {t.title}
                        </span>
                        {t.latest_review_note ? (
                          <div className="text-xs text-kk-muted mt-0.5 truncate">{t.latest_review_note}</div>
                        ) : c?.display_name ? (
                          <div className="text-xs text-kk-muted mt-0.5 truncate">From: {c.display_name}</div>
                        ) : null}
                      </div>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 text-amber-700 bg-amber-50">
                        Returned
                      </span>
                    </Link>
                  )
                })}
                {/* My assigned tasks (exclude ones already shown as review/returned) */}
                {unfinishedTasks.filter(t => !pendingReviewTasks.some(r => r.id === t.id) && !returnedTasks.some(r => r.id === t.id)).map(t => {
                  const s = getDueState(t.due_at, now, weekEnd)
                  const cfg = DUE_STATE_CONFIG[s]
                  return (
                    <Link
                      key={`task-${t.id}`}
                      href={`/tasks/${t.id}?returnTo=/today`}
                      className="flex items-center gap-3 px-4 py-2 hover:bg-[#B7A486]/25 transition-colors group"
                    >
                      <PriorityDot priority={t.priority} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">
                          {t.title}
                        </span>
                      </div>
                      {cfg.label ? (
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${cfg.cls}`}>
                          {cfg.label}
                        </span>
                      ) : t.due_at ? (
                        <span className="text-xs text-kk-muted shrink-0">{formatShortDate(t.due_at)}</span>
                      ) : null}
                    </Link>
                  )
                })}
              </div>
            )}
          </DashCard>
        </div>
      )}

      {/* ── Mobile meetings — Management mode only, hidden on desktop ────── */}
      {isManagementView && (
        <div className="lg:hidden mb-2.5">
          <DashCard
            title="Meetings"
            badge={meetingsThisWeek > 0 ? meetingsThisWeek : undefined}
            icon={<IconMeeting />}
            accentHeader
            maxRows={6}
          >
            <div className="border-b-2 border-[#171717] px-4 py-2.5">
              <QuickNewMeeting users={allActiveUsers} currentUserId={user.id} />
            </div>
            {todayMeetings.length === 0 && laterMeetings.length === 0 ? (
              <EmptyRow text="No meetings this week." />
            ) : (
              <div className="divide-y divide-[#171717]/15">
                {todayMeetings.map(m => (
                  <Link
                    key={m.id}
                    href={`/meetings/${m.id}`}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-[#B7A486]/25 transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">{m.title}</span>
                      <div className="text-xs font-medium text-kk-warn mt-0.5">Today</div>
                    </div>
                    {m.scheduled_start && (
                      <span className="text-xs text-kk-muted shrink-0 tabular-nums">{formatTime(m.scheduled_start)}</span>
                    )}
                  </Link>
                ))}
                {laterMeetings.map(m => (
                  <Link
                    key={m.id}
                    href={`/meetings/${m.id}`}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-[#B7A486]/25 transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">{m.title}</span>
                      {m.scheduled_start && (
                        <div className="text-xs text-kk-muted mt-0.5">{formatShortDate(m.scheduled_start)}</div>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </DashCard>
        </div>
      )}

      {/* ── Mobile + Add Audit button — Management mode only ─────────────── */}
      {isManagementView && (
        <div className="lg:hidden mb-2.5">
          <Link
            href="/kkc/audit"
            className="flex items-center justify-center gap-2 w-full py-4 bg-[#AD3919] text-white text-base font-bold rounded-lg hover:opacity-90 transition-opacity [box-shadow:4px_4px_0_#555555]"
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M5 5.5h6M5 8h6M5 10.5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
            + Add Audit
          </Link>
        </div>
      )}

      {/* ── Dashboard grid — hidden on mobile in Management, visible on desktop ── */}
      <div className={`grid grid-cols-1 lg:grid-cols-2 gap-2.5 items-stretch ${isManagementView ? 'hidden lg:grid' : ''}`}>

        {/* ═══ Left col, row 1 — Urgent Now ═══════════════════════════════ */}
        <div className="order-1 lg:order-none">
          <DashCard
            title="Urgent now"
            badge={urgentItems.length > 0 ? urgentItems.length : undefined}
            icon={<IconUrgent />}
            accentHeader
            maxRows={6}
          >
            {urgentItems.length === 0 ? (
              <EmptyRow text="No overdue or imminent items." />
            ) : (
              <div className="divide-y divide-[#171717]/15">
                {urgentItems.map(item => {
                  const s = getDueState(item.due_at, now, weekEnd)
                  const cfg = DUE_STATE_CONFIG[s]
                  return (
                    <Link
                      key={item.id}
                      href={item.href}
                      className="flex items-center gap-3 px-4 py-1.5 hover:bg-[#B7A486]/25 transition-colors group"
                    >
                      <PriorityDot priority={item.priority} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <TypeChip label={item.kind === 'waiting_on' ? 'WO' : 'Task'} />
                          <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate">
                            {item.title}
                          </span>
                        </div>
                        {item.ownerName && (
                          <div className="text-xs text-kk-muted mt-0.5 truncate">{item.ownerName}</div>
                        )}
                      </div>
                      {cfg.label && (
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${cfg.cls}`}>
                          {cfg.label}
                        </span>
                      )}
                    </Link>
                  )
                })}
              </div>
            )}
          </DashCard>
        </div>

        {/* ═══ Right col, row 1 — Work This Week ═════════════════════════ */}
        <div className="order-2 lg:order-none">
          <DashCard
            title="Work this week"
            badge={weekTaskItems.length > 0 ? weekTaskItems.length : undefined}
            icon={<IconWorkWeek />}
            accentHeader
            maxRows={6}
          >
            {weekTaskItems.length === 0 ? (
              <EmptyRow text="No remaining tasks this week." />
            ) : (
              <div className="divide-y divide-[#171717]/15">
                {weekTaskItems.map(item => (
                  <Link
                    key={item.id}
                    href={item.href}
                    className="flex items-center gap-3 px-4 py-1.5 hover:bg-[#B7A486]/25 transition-colors group"
                  >
                    <PriorityDot priority={item.priority} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <TypeChip label={item.kind === 'waiting_on' ? 'WO' : 'Task'} />
                        <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate">
                          {item.title}
                        </span>
                      </div>
                      {item.ownerName && (
                        <div className="text-xs text-kk-muted mt-0.5 truncate">{item.ownerName}</div>
                      )}
                    </div>
                    {item.due_at && (
                      <span className="text-xs text-kk-muted shrink-0">{formatShortDate(item.due_at)}</span>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </DashCard>
        </div>

        {/* ═══ Left col, row 2 — Meetings ═════════════════════════════════ */}
        <div className="order-3 lg:order-none">
          <DashCard
            title="Meetings"
            badge={meetingsThisWeek > 0 ? meetingsThisWeek : undefined}
            icon={<IconMeeting />}
            maxRows={6}
          >
            {todayMeetings.length === 0 && laterMeetings.length === 0 && draftMeetings.length === 0 ? (
              <EmptyRow text="No meetings this week." />
            ) : (
              <div className="divide-y divide-[#171717]/15">
                {todayMeetings.map(m => (
                  <Link
                    key={m.id}
                    href={`/meetings/${m.id}`}
                    className="flex items-center gap-3 px-4 py-1.5 hover:bg-[#B7A486]/25 transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">{m.title}</span>
                      <div className="text-xs font-medium text-kk-warn mt-0.5">Today</div>
                    </div>
                    {m.scheduled_start && (
                      <span className="text-xs text-kk-muted shrink-0 tabular-nums">{formatTime(m.scheduled_start)}</span>
                    )}
                  </Link>
                ))}
                {laterMeetings.map(m => (
                  <Link
                    key={m.id}
                    href={`/meetings/${m.id}`}
                    className="flex items-center gap-3 px-4 py-1.5 hover:bg-[#B7A486]/25 transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">{m.title}</span>
                      {m.scheduled_start && (
                        <div className="text-xs text-kk-muted mt-0.5">{formatShortDate(m.scheduled_start)}</div>
                      )}
                    </div>
                  </Link>
                ))}
                {canManage && draftMeetings.map(m => (
                  <Link
                    key={m.id}
                    href={`/meetings/${m.id}/publish`}
                    className="flex items-center gap-3 px-4 py-1.5 hover:bg-[#B7A486]/25 transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">{m.title}</span>
                      {m.scheduled_start && (
                        <div className="text-xs text-kk-muted mt-0.5">{formatShortDate(m.scheduled_start)}</div>
                      )}
                    </div>
                    <span className="text-xs text-kraft-dark font-medium shrink-0">Draft</span>
                  </Link>
                ))}
              </div>
            )}
          </DashCard>
        </div>

        {/* ═══ Right col, row 2 — Waiting Ons ════════════════════════════ */}
        <div className="order-4 lg:order-none">
          <DashCard
            title="Waiting ons"
            badge={nonUrgentWOs.length > 0 ? nonUrgentWOs.length : undefined}
            icon={<IconWaiting />}
            accentHeader
            maxRows={6}
          >
            {nonUrgentWOs.length === 0 ? (
              <EmptyRow text="No open waiting ons." />
            ) : (
              <div className="divide-y divide-[#171717]/15">
                {nonUrgentWOs.map(wo => (
                  <Link
                    key={wo.id}
                    href={`/waiting-ons/${wo.id}`}
                    className="flex items-center gap-3 px-4 py-1.5 hover:bg-[#B7A486]/25 transition-colors group"
                  >
                    <PriorityDot priority={wo.priority} />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">
                        {wo.title}
                      </span>
                      <div className="text-xs text-kk-muted mt-0.5 truncate">
                        Waiting on: {waitingForDisplay(wo)}
                      </div>
                    </div>
                    <span className="text-[10px] text-kk-muted shrink-0">
                      {PRIORITY_CONFIG[wo.priority]?.label}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </DashCard>
        </div>

        {/* ═══ Ready for Review (personal only) ══════════════════════════ */}
        {!isManagementView && pendingReviewTasks.length > 0 && (
          <div className="order-5 lg:order-none">
  <DashCard
              title="Ready for review"
              badge={pendingReviewTasks.length}
              icon={<IconReview />}
              maxRows={6}
            >
              <div className="divide-y divide-[#171717]/15">
                {pendingReviewTasks.map((t) => {
                  const o = Array.isArray(t.owner) ? t.owner[0] : t.owner
                  return (
                    <Link
                      key={t.id}
                      href={`/tasks/${t.id}?returnTo=/today`}
                      className="flex items-center gap-3 px-4 py-1.5 hover:bg-[#B7A486]/25 transition-colors group"
                    >
                      <PriorityDot priority={t.priority} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">
                          {t.title}
                        </span>
                        {o?.display_name && (
                          <div className="text-xs text-kk-muted mt-0.5">From: {o.display_name}</div>
                        )}
                      </div>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 text-kk-brand bg-kk-bad-bg">
                        Review
                      </span>
                    </Link>
                  )
                })}
              </div>
            </DashCard>
          </div>
        )}

        {/* ═══ Card 6c — Returned to You (right col, personal only) ══════════ */}
        {!isManagementView && returnedTasks.length > 0 && (
          <div className="order-6 lg:order-none">
            <DashCard
              title="Returned to you"
              badge={returnedTasks.length}
              icon={<IconReturned />}
              maxRows={6}
            >
              <div className="divide-y divide-[#171717]/15">
                {returnedTasks.map((t) => {
                  const c = Array.isArray(t.creator) ? t.creator[0] : t.creator
                  return (
                    <Link
                      key={t.id}
                      href={`/tasks/${t.id}?returnTo=/today`}
                      className="flex items-center gap-3 px-4 py-1.5 hover:bg-[#B7A486]/25 transition-colors group"
                    >
                      <PriorityDot priority={t.priority} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">
                          {t.title}
                        </span>
                        {t.latest_review_note ? (
                          <div className="text-xs text-kk-muted mt-0.5 truncate">{t.latest_review_note}</div>
                        ) : c?.display_name ? (
                          <div className="text-xs text-kk-muted mt-0.5">From: {c.display_name}</div>
                        ) : null}
                      </div>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 text-amber-700 bg-amber-50">
                        Returned
                      </span>
                    </Link>
                  )
                })}
              </div>
            </DashCard>
          </div>
        )}


      </div>
    </div>
  )
}
