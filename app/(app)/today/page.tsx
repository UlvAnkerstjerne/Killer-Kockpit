import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import {
  getCopenhagenWeekBounds,
  copenhagenMidnightUTC,
  getDueState,
  sortWorkItems,
  formatCopenhagenWeekRange,
} from '@/lib/today/weekUtils'
import { sortOpenTodos, filterCompletedThisWeek, filterTodosForToday } from '@/lib/today/todoUtils'
import type { WorkItem } from '@/lib/today/weekUtils'
import type { ViewMode, Todo } from '@/lib/types'
import TodoBlock from '../todos/TodoBlock'
import CaptureBar from '@/components/layout/CaptureBar'
import { PriorityDot, PRIORITY_CONFIG } from '@/components/ui/PriorityDot'

export const dynamic = 'force-dynamic'

// ─── Due-state badge config ──────────────────────────────────────────────────

const DUE_STATE_CONFIG = {
  overdue:   { label: 'OVERDUE',  cls: 'text-kk-bad   bg-kk-bad-bg' },
  today:     { label: 'TODAY',    cls: 'text-kk-warn  bg-kk-warn-bg' },
  tomorrow:  { label: 'TOMORROW', cls: 'text-amber-700 bg-amber-50' },
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
    <span className={`text-[10px] border rounded px-1 py-px shrink-0 ${green ? 'text-kk-good border-kk-good/40 bg-kk-good-bg/50' : 'text-kk-muted border-kk-line bg-kk-soft'}`}>
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
function IconCompleted() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M5 8l2.5 2.5L11 5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
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

// ─── Dashboard card shell ────────────────────────────────────────────────────

function DashCard({
  title, badge, footerHref, footerLabel, children, icon,
}: {
  title: string
  badge?: number | string
  footerHref?: string
  footerLabel?: string
  children: React.ReactNode
  icon?: React.ReactNode
}) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-xl overflow-hidden shadow-[0_1px_3px_0_rgba(0,0,0,0.07),0_1px_2px_-1px_rgba(0,0,0,0.04)]">
      <div className="px-4 py-2 border-b border-kk-line flex items-center justify-between">
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
        <div className="px-4 py-1.5 border-t border-kk-line flex justify-end">
          <Link href={footerHref} className="text-xs text-kk-brand font-medium hover:opacity-70 transition-opacity">
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
  const [user, params] = await Promise.all([getCurrentUser(), searchParams])
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
    completedTasksRes,
    allOpenWOsRes,
    fulfilledWOsRes,
    todayMeetingsRes,
    weekMeetingsRes,
    draftMeetingsRes,
    openTodosRes,
    completedWeekTodosRes,
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

    // Tasks completed this week
    (isManagementView
      ? supabase.from('tasks')
          .select('id, title, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name)')
          .gte('completed_at', weekStartISO)
          .lt('completed_at', weekEndISO)
          .eq('status', 'done')
          .is('archived_at', null)
      : supabase.from('tasks')
          .select('id, title, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name)')
          .eq('owner_user_id', user.id)
          .gte('completed_at', weekStartISO)
          .lt('completed_at', weekEndISO)
          .eq('status', 'done')
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

    // Waiting ons fulfilled this week
    (isManagementView
      ? supabase.from('waiting_ons')
          .select('id, title, priority, due_at, fulfilled_at, owner_user_id, waiting_for_name')
          .gte('fulfilled_at', weekStartISO)
          .lt('fulfilled_at', weekEndISO)
          .eq('status', 'fulfilled')
          .is('archived_at', null)
      : supabase.from('waiting_ons')
          .select('id, title, priority, due_at, fulfilled_at, owner_user_id, waiting_for_name')
          .eq('owner_user_id', user.id)
          .gte('fulfilled_at', weekStartISO)
          .lt('fulfilled_at', weekEndISO)
          .eq('status', 'fulfilled')
          .is('archived_at', null)
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
    supabase.from('todos')
      .select('id, user_id, title, priority, created_at, updated_at, completed_at, cancelled_at, notes, scheduled_for, recurrence_rule, recurrence_day, parent_todo_id')
      .eq('user_id', user.id)
      .is('completed_at', null)
      .is('cancelled_at', null)
      .or(`recurrence_rule.is.null,scheduled_for.lte.${todayDateStr}`)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(50),

    // Todos completed this week
    supabase.from('todos')
      .select('id, user_id, title, priority, created_at, updated_at, completed_at, cancelled_at, notes, scheduled_for, recurrence_rule, recurrence_day, parent_todo_id')
      .eq('user_id', user.id)
      .gte('completed_at', weekStartISO)
      .lt('completed_at', weekEndISO)
      .order('completed_at', { ascending: false })
      .limit(50),
  ])

  // ─── Build unified work items list ────────────────────────────────────────

  const unfinishedTasks = (unfinishedTasksRes.data || []) as RawTask[]
  const completedTasks  = (completedTasksRes.data  || []) as RawTask[]
  const allOpenWOs      = (allOpenWOsRes.data       || []) as RawWO[]
  const fulfilledWOs    = (fulfilledWOsRes.data     || []) as RawWO[]
  const draftMeetings   = (draftMeetingsRes.data    || []) as { id: string; title: string; scheduled_start: string | null }[]

  // For the work items list, only include WOs due within this week
  // (preserves the original week-scoped work list behaviour)
  const wosForWork = allOpenWOs.filter(w => w.due_at && new Date(w.due_at) < weekEnd)

  const workItems: WorkItem[] = [
    ...unfinishedTasks.map(t => ({
      id: t.id, kind: 'task' as const,
      title: t.title, priority: t.priority,
      due_at: t.due_at, done_at: null,
      href: `/tasks/${t.id}`,
      ownerName: isManagementView ? ownerName(t) : undefined,
    })),
    ...wosForWork.map(w => ({
      id: w.id, kind: 'waiting_on' as const,
      title: w.title, priority: w.priority,
      due_at: w.due_at, done_at: null,
      href: `/waiting-ons/${w.id}`,
      ownerName: isManagementView ? ownerName(w) : undefined,
    })),
    ...completedTasks.map(t => ({
      id: t.id, kind: 'task' as const,
      title: t.title, priority: t.priority,
      due_at: t.due_at, done_at: t.completed_at,
      href: `/tasks/${t.id}`,
      ownerName: isManagementView ? ownerName(t) : undefined,
    })),
    ...fulfilledWOs.map(w => ({
      id: w.id, kind: 'waiting_on' as const,
      title: w.title, priority: w.priority,
      due_at: w.due_at, done_at: w.fulfilled_at,
      href: `/waiting-ons/${w.id}`,
      ownerName: isManagementView ? ownerName(w) : undefined,
    })),
  ]

  const sorted     = sortWorkItems(workItems, now)
  const unfinished = sorted.filter(i => i.done_at === null)
  const done       = sorted.filter(i => i.done_at !== null)

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

  const openTodos        = sortOpenTodos(filterTodosForToday((openTodosRes.data ?? []) as Todo[], todayDateStr))
  const completedThisWeek = filterCompletedThisWeek((completedWeekTodosRes.data ?? []) as Todo[], now)

  // ─── At-a-glance summary counts ──────────────────────────────────────────

  const overdueCount      = urgentItems.filter(i => getDueState(i.due_at, now, weekEnd) === 'overdue').length
  const completedCount    = done.length + completedThisWeek.length
  const meetingsThisWeek  = todayMeetings.length + laterMeetings.length

  const weekRangeLabel = formatCopenhagenWeekRange(weekStart, weekEnd)

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
    <div>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between mb-1.5">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">This week</h1>
          <p className="text-sm text-kk-muted mt-0.5">{weekRangeLabel}</p>
        </div>
        {canManage && (
          <div className="flex gap-1 text-sm">
            <Link
              href="/today?view=personal"
              className={`px-3 py-1.5 rounded-lg transition-colors ${view === 'personal' ? 'bg-kk-ink text-white' : 'text-kk-muted hover:bg-kk-soft'}`}
            >
              Personal
            </Link>
            <Link
              href="/today?view=management"
              className={`px-3 py-1.5 rounded-lg transition-colors ${view === 'management' ? 'bg-kk-ink text-white' : 'text-kk-muted hover:bg-kk-soft'}`}
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

        {/* ═══ Card 1 — Urgent Now (left col, row 1) ════════════════════════ */}
        <div className="self-start order-1 lg:order-none lg:col-start-1 lg:row-start-1">
          <DashCard
            title="Urgent now"
            badge={urgentItems.length > 0 ? urgentItems.length : undefined}
            footerHref="/tasks"
            footerLabel={urgentItems.length > 6 ? `View all ${urgentItems.length} urgent items` : 'View all tasks'}
            icon={<IconUrgent />}
          >
            {urgentItems.length === 0 ? (
              <EmptyRow text="No overdue or imminent items." />
            ) : (
              <div className="divide-y divide-kk-line">
                {urgentItems.slice(0, 6).map(item => {
                  const s = getDueState(item.due_at, now, weekEnd)
                  const cfg = DUE_STATE_CONFIG[s]
                  return (
                    <Link
                      key={item.id}
                      href={item.href}
                      className="flex items-center gap-3 px-4 py-1.5 hover:bg-kk-soft transition-colors group"
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

        {/* ═══ Card 2 — To-Dos (right col, row 1) ══════════════════════════ */}
        <div className="self-start order-2 lg:order-none lg:col-start-2 lg:row-start-1">
          <TodoBlock
            openTodos={openTodos}
            completedThisWeek={[]}
            maxItems={5}
            showFooter
          />
        </div>

        {/* ═══ Card 3 — Work This Week (left col, row 2) ═══════════════════ */}
        <div className="self-start order-3 lg:order-none lg:col-start-1 lg:row-start-2">
          <DashCard
            title="Work this week"
            badge={weekTaskItems.length > 0 ? weekTaskItems.length : undefined}
            footerHref="/tasks"
            footerLabel="View all tasks"
            icon={<IconWorkWeek />}
          >
            {weekTaskItems.length === 0 ? (
              <EmptyRow text="No remaining tasks this week." />
            ) : (
              <div className="divide-y divide-kk-line">
                {weekTaskItems.slice(0, 7).map(item => (
                  <Link
                    key={item.id}
                    href={item.href}
                    className="flex items-center gap-3 px-4 py-1.5 hover:bg-kk-soft transition-colors group"
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
                {weekTaskItems.length > 7 && (
                  <div className="px-4 py-2 text-xs text-kk-muted">
                    + {weekTaskItems.length - 7} more
                  </div>
                )}
              </div>
            )}
          </DashCard>
        </div>

        {/* ═══ Card 4 — Waiting Ons (right col, row 2) ═════════════════════ */}
        <div className="self-start order-4 lg:order-none lg:col-start-2 lg:row-start-2">
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
              <div className="divide-y divide-kk-line">
                {nonUrgentWOs.slice(0, 5).map(wo => (
                  <Link
                    key={wo.id}
                    href={`/waiting-ons/${wo.id}`}
                    className="flex items-center gap-3 px-4 py-1.5 hover:bg-kk-soft transition-colors group"
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

        {/* ═══ Card 5 — Meetings (right col, row 3) ════════════════════════ */}
        <div className="self-start order-5 lg:order-none lg:col-start-2 lg:row-start-3">
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
              <div className="divide-y divide-kk-line">
                {/* Today */}
                {todayMeetings.map(m => (
                  <Link
                    key={m.id}
                    href={`/meetings/${m.id}`}
                    className="flex items-center gap-3 px-4 py-1.5 hover:bg-kk-soft transition-colors group"
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
                {/* Later this week — cap total to keep card compact */}
                {laterMeetings.slice(0, Math.max(0, 5 - todayMeetings.length)).map(m => (
                  <Link
                    key={m.id}
                    href={`/meetings/${m.id}`}
                    className="flex items-center gap-3 px-4 py-1.5 hover:bg-kk-soft transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">{m.title}</span>
                      {m.scheduled_start && (
                        <div className="text-xs text-kk-muted mt-0.5">{formatShortDate(m.scheduled_start)}</div>
                      )}
                    </div>
                  </Link>
                ))}
                {/* Draft meetings awaiting review (management only) */}
                {canManage && draftMeetings.slice(0, 2).map(m => (
                  <Link
                    key={m.id}
                    href={`/meetings/${m.id}/publish`}
                    className="flex items-center gap-3 px-4 py-1.5 hover:bg-kk-soft transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-kk-ink group-hover:underline truncate block">{m.title}</span>
                      {m.scheduled_start && (
                        <div className="text-xs text-kk-muted mt-0.5">{formatShortDate(m.scheduled_start)}</div>
                      )}
                    </div>
                    <span className="text-xs text-purple-700 font-medium shrink-0">Draft</span>
                  </Link>
                ))}
              </div>
            )}
          </DashCard>
        </div>

        {/* ═══ Card 6 — Completed This Week (left col, row 3) ══════════════ */}
        <div className="self-start order-6 lg:order-none lg:col-start-1 lg:row-start-3">
          {(() => {
            const visibleDone  = done.slice(0, 3)
            const visibleTodos = completedThisWeek.slice(0, Math.max(0, 3 - visibleDone.length))
            const overflow     = completedCount - visibleDone.length - visibleTodos.length

            return (
              <DashCard
                title="Completed this week"
                badge={completedCount > 0 ? completedCount : undefined}
                footerHref="/tasks"
                footerLabel="View all completed"
                icon={<IconCompleted />}
              >
                {completedCount === 0 ? (
                  <EmptyRow text="Nothing completed yet — week is just getting started." />
                ) : (
                  <div className="divide-y divide-kk-line">
                    {visibleDone.map(item => (
                      <Link
                        key={item.id}
                        href={item.href}
                        className="flex items-center gap-3 px-4 py-2 hover:bg-kk-soft transition-colors group opacity-80"
                      >
                        <PriorityDot priority={item.priority} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {item.kind === 'waiting_on' && <TypeChip label="WO" green />}
                            <span className="text-sm text-kk-good line-through truncate">{item.title}</span>
                          </div>
                          {item.ownerName && (
                            <div className="text-xs text-kk-muted mt-0.5 truncate">{item.ownerName}</div>
                          )}
                        </div>
                        {item.done_at && (
                          <span className="text-xs text-kk-good/70 shrink-0">{formatShortDate(item.done_at)}</span>
                        )}
                      </Link>
                    ))}
                    {visibleTodos.map(todo => (
                      <div key={todo.id} className="flex items-center gap-3 px-4 py-1.5 opacity-80">
                        <PriorityDot priority={todo.priority} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <TypeChip label="To-Do" green />
                            <span className="text-sm text-kk-good line-through truncate">{todo.title}</span>
                          </div>
                        </div>
                        {todo.completed_at && (
                          <span className="text-xs text-kk-good/70 shrink-0">{formatShortDate(todo.completed_at)}</span>
                        )}
                      </div>
                    ))}
                    {overflow > 0 && (
                      <div className="px-4 py-2 text-xs text-kk-muted">+ {overflow} more</div>
                    )}
                  </div>
                )}
              </DashCard>
            )
          })()}
        </div>

        {/* ═══ Card 7 — At a Glance (right col, row 4) ════════════════════ */}
        <div className="self-start order-7 lg:order-none lg:col-start-2 lg:row-start-4">
          <DashCard title="This week at a glance" icon={<IconGlance />}>
            <div className="grid grid-cols-2 gap-px bg-kk-line m-px overflow-hidden">
              {([
                { label: 'Open items',   value: unfinished.length, accent: false },
                { label: 'Overdue',      value: overdueCount,      accent: overdueCount > 0 },
                { label: 'Completed',    value: completedCount,    accent: false },
                { label: 'Meetings',     value: meetingsThisWeek,  accent: false },
              ] as const).map(({ label, value, accent }) => (
                <div key={label} className="bg-kk-panel px-4 py-2.5">
                  <div className={`text-2xl font-bold tabular-nums leading-none ${accent ? 'text-kk-bad' : value === 0 ? 'text-kk-muted' : 'text-kk-ink'}`}>
                    {value}
                  </div>
                  <div className="text-xs text-kk-muted mt-1 leading-tight">{label}</div>
                </div>
              ))}
            </div>
          </DashCard>
        </div>

      </div>
    </div>
  )
}
