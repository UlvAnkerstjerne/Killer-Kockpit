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
// ─── Dashboard card shell ────────────────────────────────────────────────────

function DashCard({
  title, badge, footerHref, footerLabel, children, icon, accentHeader,
}: {
  title: string
  badge?: number | string
  footerHref?: string
  footerLabel?: string
  children: React.ReactNode
  icon?: React.ReactNode
  accentHeader?: boolean
}) {
  return (
    <div className="bg-kraft-light border-2 border-[#171717] rounded-lg overflow-hidden [box-shadow:4px_4px_0_#555555]">
      <div className="px-4 py-2 border-b-2 border-[#171717] flex items-center justify-between bg-kraft-brown">
        <h2 className="text-sm font-bold text-kk-ink flex items-center gap-1.5">
          {icon && <span className="text-kk-ink/50 shrink-0">{icon}</span>}
          {title}
          {badge !== undefined && (
            <span className="text-kk-muted font-normal ml-1">· {badge}</span>
          )}
        </h2>
      </div>
      <div>{children}</div>
      {footerHref && footerLabel && (
        <div className="px-4 py-1.5 border-t border-[#171717]/20 flex justify-end">
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
    expectedSubmissionsRes,
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

    // Tasks I delegated that are expected this week (I created, someone else owns, due this week, not done)
    supabase.from('tasks')
      .select('id, title, priority, due_at, status, owner:owner_user_id (id, display_name)')
      .eq('created_by_user_id', user.id)
      .neq('owner_user_id', user.id)
      .lt('due_at', weekEndISO)
      .not('due_at', 'is', null)
      .not('status', 'in', '("done","cancelled","pending_review")')
      .is('archived_at', null)
      .order('due_at', { ascending: true })
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
  // Genuinely urgent = critical/normal priority (P1/P2) that are overdue or due today,
  // OR any priority that is overdue by more than 2 days. Tomorrow items are not urgent.

  const urgentItems = unfinished.filter(item => {
    const s = getDueState(item.due_at, now, weekEnd)
    if (s === 'overdue') {
      // P1/P2 are always urgent when overdue
      if (item.priority <= 2) return true
      // P3/P4 only urgent if overdue by more than 2 days (significantly late)
      if (item.due_at) {
        const daysOverdue = (now.getTime() - new Date(item.due_at).getTime()) / 86_400_000
        return daysOverdue > 2
      }
      return false
    }
    // Due today with high priority
    if (s === 'today' && item.priority <= 2) return true
    return false
  })

  // Work This Week = non-urgent tasks (WOs are shown in dedicated WOs card)
  const urgentIds = new Set(urgentItems.map(i => i.id))
  const weekTaskItems = unfinished.filter(item => {
    return item.kind === 'task' && !urgentIds.has(item.id)
  })

  // Waiting Ons card: all open WOs excluding the ones already in Urgent Now
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

  const pendingReviewTasks = (!isManagementView ? (pendingReviewTasksRes.data || []) : []) as RawPendingReview[]
  const returnedTasks      = (!isManagementView ? (returnedTasksRes.data      || []) : []) as RawReturned[]

  type RawExpectedSubmission = {
    id: string; title: string; priority: number; due_at: string | null; status: string
    owner: { id: string; display_name: string } | Array<{ id: string; display_name: string }> | undefined
  }
  const expectedSubmissions = (!isManagementView ? (expectedSubmissionsRes.data || []) : []) as RawExpectedSubmission[]

  // ─── At-a-glance summary counts ──────────────────────────────────────────

  const meetingsThisWeek  = todayMeetings.length + laterMeetings.length


  // ─── Render ───────────────────────────────────────────────────────────────
  //
  // Layout: 2-column CSS grid on desktop (lg+).
  //   Left column  (3fr): My To-Dos (largest, most prominent)
  //   Right column (2fr): Urgent Now (conditional) → Work This Week → Waiting Ons → Meetings
  //
  // Mobile (< lg): single column, visual order via CSS `order-N`.

  // Work This Week section counts
  const workWeekTotal = pendingReviewTasks.length + returnedTasks.length + weekTaskItems.length + expectedSubmissions.length

  return (
    <div className="-m-4 p-4 min-h-screen bg-kraft-light">

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className="flex items-end justify-between -mx-4 px-4 -mt-4 pt-4 pb-3 mb-1.5 border-b border-[#171717]/20">
        <h1
          className="font-brand leading-none text-8xl font-black text-[#AD3919] tracking-tight [text-shadow:2px_3px_6px_rgba(0,0,0,0.25)]"
          style={{ WebkitTextStroke: '0.25px #171717' }}
        >
          KILLER KOCKPIT
        </h1>
        {canManage && (
          <div className="flex gap-1 text-sm">
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

      {/* ── Inline capture buttons ──────────────────────────────────────────── */}
      <div className="mb-3">
        <CaptureBar user={user} inline />
      </div>

      {/* ── Dashboard grid ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-2.5 items-start">

        {/* ═══ My To-Dos — largest panel (left col, spans full height) ══════ */}
        <div className="self-start order-1 lg:order-none lg:col-start-1 lg:row-start-1 lg:row-span-4">
          <TodoBlock
            openTodos={openTodos}
            completedThisWeek={[]}
            maxItems={20}
            showFooter
            accentHeader
            allUsers={todoAllUsers}
            projects={todoProjects}
            currentUserId={user.id}
          />
        </div>

        {/* ═══ Urgent Now (right col, row 1) — only when genuinely urgent ═══ */}
        {urgentItems.length > 0 && (
          <div className="self-start order-2 lg:order-none lg:col-start-2 lg:row-start-1">
            <DashCard
              title="Urgent now"
              badge={urgentItems.length}
              footerHref="/tasks"
              footerLabel={urgentItems.length > 6 ? `View all ${urgentItems.length} urgent items` : 'View all tasks'}
              icon={<IconUrgent />}
              accentHeader
            >
              <div className="divide-y divide-[#171717]/15">
                {urgentItems.slice(0, 6).map(item => {
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
            </DashCard>
          </div>
        )}

        {/* ═══ Work This Week (right col) — unified task panel ══════════════ */}
        <div className="self-start order-3 lg:order-none lg:col-start-2">
          <DashCard
            title="Work this week"
            badge={workWeekTotal > 0 ? workWeekTotal : undefined}
            footerHref="/tasks"
            footerLabel="View all tasks"
            icon={<IconWorkWeek />}
            accentHeader
          >
            {workWeekTotal === 0 ? (
              <EmptyRow text="No tasks this week." />
            ) : (
              <div>
                {/* Section 1: For review — tasks awaiting my approval */}
                {!isManagementView && pendingReviewTasks.length > 0 && (
                  <>
                    <div className="px-4 py-1 text-[10px] font-bold uppercase tracking-wider text-kk-muted border-b border-[#171717]/10 bg-[#B7A486]/10">
                      For your review
                    </div>
                    <div className="divide-y divide-[#171717]/15">
                      {pendingReviewTasks.map(t => {
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
                  </>
                )}

                {/* Section 1b: Returned to you — tasks sent back */}
                {!isManagementView && returnedTasks.length > 0 && (
                  <>
                    <div className="px-4 py-1 text-[10px] font-bold uppercase tracking-wider text-kk-muted border-b border-[#171717]/10 bg-[#B7A486]/10">
                      Returned to you
                    </div>
                    <div className="divide-y divide-[#171717]/15">
                      {returnedTasks.map(t => {
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
                  </>
                )}

                {/* Section 2: Assigned to me — tasks I own, due this week */}
                {weekTaskItems.length > 0 && (
                  <>
                    {(pendingReviewTasks.length > 0 || returnedTasks.length > 0) && !isManagementView && (
                      <div className="px-4 py-1 text-[10px] font-bold uppercase tracking-wider text-kk-muted border-b border-[#171717]/10 bg-[#B7A486]/10">
                        Assigned to {isManagementView ? 'team' : 'you'}
                      </div>
                    )}
                    <div className="divide-y divide-[#171717]/15">
                      {weekTaskItems.slice(0, 7).map(item => {
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
                              <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">
                                {item.title}
                              </span>
                              {item.ownerName && (
                                <div className="text-xs text-kk-muted mt-0.5 truncate">{item.ownerName}</div>
                              )}
                            </div>
                            {cfg.label ? (
                              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${cfg.cls}`}>
                                {cfg.label}
                              </span>
                            ) : item.due_at ? (
                              <span className="text-xs text-kk-muted shrink-0">{formatShortDate(item.due_at)}</span>
                            ) : null}
                          </Link>
                        )
                      })}
                      {weekTaskItems.length > 7 && (
                        <div className="px-4 py-2 text-xs text-kk-muted">
                          + {weekTaskItems.length - 7} more
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* Section 3: Expected submissions — tasks I delegated */}
                {!isManagementView && expectedSubmissions.length > 0 && (
                  <>
                    <div className="px-4 py-1 text-[10px] font-bold uppercase tracking-wider text-kk-muted border-b border-[#171717]/10 bg-[#B7A486]/10">
                      Expected from others
                    </div>
                    <div className="divide-y divide-[#171717]/15">
                      {expectedSubmissions.slice(0, 5).map(t => {
                        const o = Array.isArray(t.owner) ? t.owner[0] : t.owner
                        const s = getDueState(t.due_at, now, weekEnd)
                        const cfg = DUE_STATE_CONFIG[s]
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
                                <div className="text-xs text-kk-muted mt-0.5">{o.display_name}</div>
                              )}
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
                      {expectedSubmissions.length > 5 && (
                        <div className="px-4 py-2 text-xs text-kk-muted">
                          + {expectedSubmissions.length - 5} more
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </DashCard>
        </div>

        {/* ═══ Waiting Ons (right col) ═════════════════════════════════════ */}
        <div className="self-start order-4 lg:order-none lg:col-start-2">
          <DashCard
            title="Waiting ons"
            badge={nonUrgentWOs.length > 0 ? nonUrgentWOs.length : undefined}
            footerHref="/waiting-ons"
            footerLabel="View all waiting ons"
            icon={<IconWaiting />}
          >
            {nonUrgentWOs.length === 0 ? (
              <EmptyRow text="No open waiting ons." />
            ) : (
              <div className="divide-y divide-[#171717]/15">
                {nonUrgentWOs.slice(0, 5).map(wo => (
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
                {nonUrgentWOs.length > 5 && (
                  <div className="px-4 py-2 text-xs text-kk-muted">
                    + {nonUrgentWOs.length - 5} more
                  </div>
                )}
              </div>
            )}
          </DashCard>
        </div>

        {/* ═══ Meetings (right col) ════════════════════════════════════════ */}
        <div className="self-start order-5 lg:order-none lg:col-start-2">
          <DashCard
            title="Meetings"
            badge={meetingsThisWeek > 0 ? meetingsThisWeek : undefined}
            footerHref="/meetings"
            footerLabel="View all meetings"
            icon={<IconMeeting />}
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
                {laterMeetings.slice(0, Math.max(0, 5 - todayMeetings.length)).map(m => (
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
                {canManage && draftMeetings.slice(0, 2).map(m => (
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

      </div>
    </div>
  )
}
