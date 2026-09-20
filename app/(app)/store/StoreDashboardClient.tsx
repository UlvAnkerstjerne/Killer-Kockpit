'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  DndContext,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SmartMouseSensor, SmartTouchSensor } from '@/lib/dnd/sensors'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import { reorderTodos } from '@/lib/actions/todos'
import type {
  RevenueMetrics,
  LabourMetrics,
  KitchenMetrics,
  GbpMetrics,
  StockTakeStatus,
  MeatUseStatus,
  RoutineStatus,
} from '@/lib/store/adapter'

// ─── Types from server ────────────────────────────────────────────────────────

export interface DashboardTodo {
  id: string
  title: string
  completed_at: string | null
  priority: number
  /** Manual display order — mirrors todos.sort_order. NULL = new/unsorted (appears first). */
  sort_order: number | null
}

export interface DashboardTask {
  id: string
  title: string
  status: string
  due_at: string | null
  created_by: string | null
}

export interface DashboardAudit {
  id: string
  score_pct: number | null
  audit_status: string | null
  submitted_at: string | null
  location_name: string
}

export interface DashboardDiner {
  id: string
  score_pct: number | null
  status: string | null
  submitted_at: string | null
  location_name: string | null
}

export interface StoreDashboardProps {
  storeName: string
  storeOptions?: Array<{ id: string; short_name: string }>
  managerName: string
  revenueToday: RevenueMetrics
  revenueWeek: RevenueMetrics
  revenueMonth: RevenueMetrics
  labourToday: LabourMetrics
  labourWeek: LabourMetrics
  labourMonth: LabourMetrics
  kitchenToday: KitchenMetrics
  kitchenWeek: KitchenMetrics
  kitchenMonth: KitchenMetrics
  gbp: GbpMetrics
  latestAudit: DashboardAudit | null
  latestDiner: DashboardDiner | null
  todos: DashboardTodo[]
  tasks: DashboardTask[]
  stockTake: StockTakeStatus
  meatUse: MeatUseStatus
}

type Period = 'today' | 'week' | 'month'

// ─── Chevron ──────────────────────────────────────────────────────────────────

function Chevron() {
  return (
    <svg
      width="16" height="16" viewBox="0 0 16 16" fill="none"
      className="shrink-0 text-[#171717]" aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ─── Section heading ──────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t-2 border-[#171717] pt-3 mb-3">
      <h2 className="text-[10px] font-black tracking-[0.18em] uppercase text-[#171717]">
        {children}
      </h2>
    </div>
  )
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function formatDKK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
  return `${n}`
}

function formatPct(n: number, signed = false): string {
  const s = (n * 100).toFixed(1)
  return signed && n > 0 ? `+${s}%` : `${s}%`
}

function formatPp(n: number | null): string {
  if (n == null) return '—'
  const s = Math.abs(n).toFixed(1)
  return n < 0 ? `−${s}pp` : `+${s}pp`
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Europe/Copenhagen',
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function formatRelDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const now = new Date()
  const diff = Math.round((now.getTime() - d.getTime()) / 86_400_000)
  if (diff === 0) return 'today'
  if (diff === 1) return 'yesterday'
  if (diff < 7)  return `${diff}d ago`
  return formatDate(iso)
}

function routineLabel(status: RoutineStatus, lastAt: string | null): string {
  if (status === 'done' && lastAt) return `Last done ${formatRelDate(lastAt)}`
  if (status === 'overdue')        return 'Overdue — not completed'
  if (status === 'pending')        return 'Due today'
  return 'Not yet set up'
}

// ─── Store Performance ────────────────────────────────────────────────────────

function StorePerformance({
  revenueToday, revenueWeek, revenueMonth,
  labourToday, labourWeek, labourMonth,
  kitchenToday, kitchenWeek, kitchenMonth,
}: Pick<StoreDashboardProps,
  'revenueToday' | 'revenueWeek' | 'revenueMonth' |
  'labourToday' | 'labourWeek' | 'labourMonth' |
  'kitchenToday' | 'kitchenWeek' | 'kitchenMonth'
>) {
  const [period, setPeriod] = useState<Period>('today')

  const rev = period === 'today' ? revenueToday : period === 'week' ? revenueWeek : revenueMonth
  const lab = period === 'today' ? labourToday  : period === 'week' ? labourWeek  : labourMonth
  const kit = period === 'today' ? kitchenToday : period === 'week' ? kitchenWeek : kitchenMonth

  const TABS: { key: Period; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'week',  label: 'Week'  },
    { key: 'month', label: 'Month' },
  ]

  return (
    <div>
      {/* Segmented control */}
      <div className="flex border-2 border-[#171717] mb-4">
        {TABS.map((t, i) => (
          <button
            key={t.key}
            onClick={() => setPeriod(t.key)}
            className={[
              'flex-1 py-2.5 text-[11px] font-black tracking-[0.12em] uppercase transition-colors',
              i > 0 ? 'border-l-2 border-[#171717]' : '',
              period === t.key
                ? 'bg-[#171717] text-[#D2C3A7]'
                : 'bg-[#D2C3A7] text-[#171717] hover:bg-[#C8B89A]',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Compound block: Revenue + Labour/Kitchen */}
      <div className="border-2 border-[#171717] flex">
        {/* Revenue — left */}
        <div className="flex-1 p-4 border-r-2 border-[#171717]">
          <div className="text-[10px] font-black tracking-[0.15em] uppercase text-[#8D795F] mb-1">
            Revenue
          </div>
          <div className="font-brand text-3xl font-black text-[#171717] leading-none">
            {formatDKK(rev.revenue)}
          </div>
          <div className="text-[10px] text-[#171717] mt-1">DKK</div>
          {rev.vsLast != null && (
            <div className="mt-3 flex items-center gap-1.5">
              <span className={[
                'text-xs font-bold',
                rev.vsLast >= 0 ? 'text-[#2f6d4c]' : 'text-[#AD3919]',
              ].join(' ')}>
                {formatPct(rev.vsLast, true)}
              </span>
              <span className="text-[10px] text-[#8D795F]">vs last</span>
            </div>
          )}
          {rev.vsBudget != null && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={[
                'text-xs font-bold',
                rev.vsBudget >= 0 ? 'text-[#2f6d4c]' : 'text-[#AD3919]',
              ].join(' ')}>
                {formatPct(rev.vsBudget, true)}
              </span>
              <span className="text-[10px] text-[#8D795F]">vs budget</span>
            </div>
          )}
        </div>

        {/* Labour + Kitchen — shared red column */}
        <div className="w-[130px] shrink-0 flex flex-col bg-[#AD3919]">
          {/* Labour */}
          <div className="flex-1 p-3 border-b-2 border-[#171717]">
            <div className="text-[10px] font-black tracking-[0.1em] uppercase text-[#D2C3A7] mb-1">
              Labour
            </div>
            <div className="text-2xl font-black text-white leading-none tracking-tight">
              {lab.labourPct.toFixed(1)}%
            </div>
            {lab.vsTarget != null && (
              <div className="text-[10px] text-[#D2C3A7] mt-1">
                {formatPp(lab.vsTarget)} target
              </div>
            )}
          </div>
          {/* Kitchen */}
          <div className="flex-1 p-3">
            <div className="text-[10px] font-black tracking-[0.1em] uppercase text-[#D2C3A7] mb-1">
              Kitchen
            </div>
            <div className="text-2xl font-black text-white leading-none tracking-tight">
              {kit.kitchenPct.toFixed(1)}%
            </div>
            {kit.vsTarget != null && (
              <div className="text-[10px] text-[#D2C3A7] mt-1">
                {formatPp(kit.vsTarget)} target
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Customer Feedback ────────────────────────────────────────────────────────

function CustomerFeedback({ gbp }: Pick<StoreDashboardProps, 'gbp'>) {
  return (
    <div className="border-2 border-[#171717] flex">
      {/* Google rating */}
      <div className="flex-1 p-4 border-r-2 border-[#171717]">
        <div className="text-[10px] font-black tracking-[0.15em] uppercase text-[#8D795F] mb-2">
          Google Rating
        </div>
        {gbp.rating != null ? (
          <>
            <div className="text-3xl font-black text-[#171717] leading-none">
              {gbp.rating.toFixed(1)}
            </div>
            <div className="text-[10px] text-[#8D795F] mt-1">
              ★ {gbp.reviewCount ?? '—'} reviews
            </div>
          </>
        ) : (
          <div className="text-xs text-[#8D795F]">Unavailable</div>
        )}
      </div>

      {/* Reviews this week */}
      <div className="flex-1 p-4">
        <div className="text-[10px] font-black tracking-[0.15em] uppercase text-[#8D795F] mb-2">
          Reviews This Week
        </div>
        {gbp.reviewsThisWeek != null ? (
          <>
            <div className="text-3xl font-black text-[#171717] leading-none">
              {gbp.reviewsThisWeek}
            </div>
            <div className="text-[10px] text-[#8D795F] mt-1">
              new reviews
            </div>
          </>
        ) : (
          <div className="text-xs text-[#8D795F]">Unavailable</div>
        )}
      </div>
    </div>
  )
}

// ─── Latest Checks ────────────────────────────────────────────────────────────

function LatestChecks({
  latestAudit,
  latestDiner,
}: Pick<StoreDashboardProps, 'latestAudit' | 'latestDiner'>) {
  const AUDIT_STATUS_COLOR: Record<string, string> = {
    GREEN:       'text-[#2f6d4c]',
    LIGHT_GREEN: 'text-[#2f6d4c]',
    YELLOW:      'text-[#8a5b16]',
    ORANGE:      'text-[#AD3919]',
    RED:         'text-[#AD3919]',
  }

  return (
    <div className="border-2 border-[#171717] flex">
      {/* Operational Audit */}
      <Link
        href={latestAudit ? `/kkc/audits/${latestAudit.id}` : '/kkc/audits'}
        className="flex-1 p-4 border-r-2 border-[#171717] group"
      >
        <div className="text-[10px] font-black tracking-[0.15em] uppercase text-[#8D795F] mb-2">
          Operational Audit
        </div>
        {latestAudit ? (
          <>
            <div className="text-3xl font-black text-[#171717] leading-none">
              {latestAudit.score_pct != null
                ? `${Math.round(latestAudit.score_pct)}%`
                : '—'}
            </div>
            {latestAudit.audit_status && (
              <div className={[
                'text-[10px] font-bold mt-1 uppercase tracking-wide',
                AUDIT_STATUS_COLOR[latestAudit.audit_status] ?? 'text-[#8D795F]',
              ].join(' ')}>
                {latestAudit.audit_status.replace('_', ' ')}
              </div>
            )}
            <div className="text-[10px] text-[#8D795F] mt-0.5">
              {formatRelDate(latestAudit.submitted_at)}
            </div>
          </>
        ) : (
          <div className="text-xs text-[#8D795F]">No audits yet</div>
        )}
      </Link>

      {/* Mystery Diner */}
      <Link
        href={latestDiner ? `/diner/${latestDiner.id}` : '/diner'}
        className="flex-1 p-4 group"
      >
        <div className="text-[10px] font-black tracking-[0.15em] uppercase text-[#8D795F] mb-2">
          Mystery Diner
        </div>
        {latestDiner ? (
          <>
            <div className="text-3xl font-black text-[#171717] leading-none">
              {latestDiner.score_pct != null
                ? `${Math.round(latestDiner.score_pct)}%`
                : '—'}
            </div>
            <div className={[
              'text-[10px] font-bold mt-1 uppercase tracking-wide',
              latestDiner.status === 'GREEN'  ? 'text-[#2f6d4c]' :
              latestDiner.status === 'YELLOW' ? 'text-[#8a5b16]' :
              latestDiner.status === 'RED'    ? 'text-[#AD3919]' :
              'text-[#8D795F]',
            ].join(' ')}>
              {latestDiner.status ?? 'Pending'}
            </div>
            <div className="text-[10px] text-[#8D795F] mt-0.5">
              {formatRelDate(latestDiner.submitted_at)}
            </div>
          </>
        ) : (
          <div className="text-xs text-[#8D795F]">No visit yet</div>
        )}
      </Link>
    </div>
  )
}

// ─── My To-Dos ────────────────────────────────────────────────────────────────

// Sortable open-todo row for the Store Manager Dashboard.
// Whole-row dragging: SmartMouseSensor/SmartTouchSensor skip native interactive
// elements, so the visual-only checkbox and title area are freely draggable.
function SortableStoreTodoRow({ todo }: { todo: DashboardTodo }) {
  const {
    attributes, listeners,
    setNodeRef,
    transform, transition, isDragging,
  } = useSortable({ id: todo.id })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={[
        'flex items-stretch border-b-2 border-[#171717]',
        isDragging ? 'opacity-50 z-10 relative shadow-[0_4px_12px_rgba(0,0,0,0.15)]' : '',
        'bg-[#D2C3A7]',
      ].join(' ')}
    >
      {/* Drag affordance (decorative only — whole row is draggable) */}
      <div
        aria-hidden="true"
        className="flex items-center justify-center w-6 shrink-0
                   text-[#8D795F] opacity-25 pointer-events-none"
      >
        <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
          <circle cx="3" cy="2.5" r="1.2"/>
          <circle cx="7" cy="2.5" r="1.2"/>
          <circle cx="3" cy="7" r="1.2"/>
          <circle cx="7" cy="7" r="1.2"/>
          <circle cx="3" cy="11.5" r="1.2"/>
          <circle cx="7" cy="11.5" r="1.2"/>
        </svg>
      </div>

      {/* Todo content */}
      <div className="flex items-start gap-3 flex-1 min-w-0 pr-4 py-3">
        {/* Visual-only checkbox */}
        <div className="mt-0.5 w-5 h-5 shrink-0 border-2 border-[#171717] flex items-center justify-center bg-transparent" />
        <span className="flex-1 text-sm text-[#171717] leading-snug">
          {todo.title}
        </span>
      </div>
    </div>
  )
}

function MyTodos({ todos }: Pick<StoreDashboardProps, 'todos'>) {
  const initialOpen = todos.filter(t => !t.completed_at)
  const completed   = todos.filter(t => t.completed_at).slice(0, 3)

  // Local state for optimistic DnD reordering of open todos
  const [openTodos, setOpenTodos] = useState<DashboardTodo[]>(initialOpen)
  useEffect(() => { setOpenTodos(todos.filter(t => !t.completed_at)) }, [todos])

  const sensors = useSensors(
    useSensor(SmartMouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(SmartTouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = openTodos.findIndex(t => t.id === active.id)
    const newIndex  = openTodos.findIndex(t => t.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const reordered = arrayMove(openTodos, oldIndex, newIndex)
    setOpenTodos(reordered)
    reorderTodos(reordered.map(t => t.id)).catch(() => {/* silent — server already logged */})
  }, [openTodos])

  return (
    <div className="border-2 border-[#171717]">
      {openTodos.length === 0 && completed.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-[#8D795F]">
          No to-dos. Add one below.
        </div>
      ) : (
        <div>
          {/* ── Draggable open todos ── */}
          {openTodos.length > 0 && (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            >
              <SortableContext
                items={openTodos.map(t => t.id)}
                strategy={verticalListSortingStrategy}
              >
                {openTodos.map(todo => (
                  <SortableStoreTodoRow key={todo.id} todo={todo} />
                ))}
              </SortableContext>
            </DndContext>
          )}

          {/* ── Completed todos (static, not draggable) ── */}
          {completed.map((todo) => (
            <div
              key={todo.id}
              className="flex items-start gap-3 px-4 py-3 border-b-2 border-[#171717] bg-[#D2C3A7]/50"
            >
              <div className="mt-0.5 w-5 h-5 shrink-0 border-2 border-[#171717] flex items-center justify-center bg-[#171717]">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M2 6l3 3 5-5" stroke="#D2C3A7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <span className="flex-1 text-sm text-[#171717] leading-snug line-through opacity-50">
                {todo.title}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Add a To-Do */}
      <Link
        href="/todos"
        className="flex items-center justify-center w-full py-3 bg-[#AD3919] border-t-2 border-[#171717] text-[11px] font-black tracking-[0.15em] uppercase text-white hover:bg-[#9a3215] transition-colors"
      >
        + Add a To-Do
      </Link>
    </div>
  )
}

// ─── Task status label / colour ───────────────────────────────────────────────

const TASK_STATUS: Record<string, { label: string; cls: string }> = {
  proposed:       { label: 'Proposed',    cls: 'text-[#8D795F]' },
  open:           { label: 'Open',        cls: 'text-[#171717]' },
  in_progress:    { label: 'In progress', cls: 'text-[#8a5b16]' },
  blocked:        { label: 'Blocked',     cls: 'text-[#AD3919]' },
  pending_review: { label: 'In review',   cls: 'text-[#2f6d4c]' },
  done:           { label: 'Done',        cls: 'text-[#2f6d4c]' },
  cancelled:      { label: 'Cancelled',   cls: 'text-[#8D795F]' },
}

// ─── My Tasks ─────────────────────────────────────────────────────────────────

function MyTasks({ tasks }: Pick<StoreDashboardProps, 'tasks'>) {
  if (tasks.length === 0) {
    return (
      <div className="border-2 border-[#171717] px-4 py-6 text-center text-xs text-[#8D795F]">
        No open tasks assigned to you.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {tasks.map((task) => {
        const st = TASK_STATUS[task.status] ?? { label: task.status, cls: 'text-[#8D795F]' }
        return (
          <Link
            key={task.id}
            href={`/tasks/${task.id}?returnTo=/store`}
            className="flex items-center gap-3 border-2 border-[#171717] px-4 py-3 bg-[#D2C3A7] hover:bg-[#C8B89A] transition-colors group"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-[#171717] leading-snug truncate">
                {task.title}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                {task.due_at && (
                  <span className="text-[10px] text-[#8D795F]">
                    Due {formatDate(task.due_at)}
                  </span>
                )}
                {task.created_by && (
                  <span className="text-[10px] text-[#8D795F]">
                    From {task.created_by}
                  </span>
                )}
                <span className={`text-[10px] font-bold ${st.cls}`}>
                  {st.label}
                </span>
              </div>
            </div>
            <Chevron />
          </Link>
        )
      })}
    </div>
  )
}

// ─── Store Routines ───────────────────────────────────────────────────────────

function RoutineRow({
  label,
  status,
  lastCompletedAt,
  href,
}: {
  label: string
  status: RoutineStatus
  lastCompletedAt: string | null
  href: string
}) {
  const sub = routineLabel(status, lastCompletedAt)

  return (
    <Link
      href={href}
      className="flex items-center gap-3 border-2 border-[#171717] px-4 py-4 bg-[#D2C3A7] hover:bg-[#C8B89A] transition-colors"
    >
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-black tracking-[0.15em] uppercase text-[#171717]">
          {label}
        </div>
        <div className="text-[10px] text-[#8D795F] mt-0.5">{sub}</div>
      </div>
      <Chevron />
    </Link>
  )
}

function StoreRoutines({
  stockTake,
  meatUse,
}: Pick<StoreDashboardProps, 'stockTake' | 'meatUse'>) {
  return (
    <div className="flex flex-col gap-2">
      <RoutineRow
        label="Stock Take"
        status={stockTake.status}
        lastCompletedAt={stockTake.lastCompletedAt}
        href="/store/stock-take"
      />
      <RoutineRow
        label="Meat Use"
        status={meatUse.status}
        lastCompletedAt={meatUse.lastCompletedAt}
        href="/store/meat-use"
      />
    </div>
  )
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

export default function StoreDashboardClient(props: StoreDashboardProps) {
  const {
    storeName,
    revenueToday, revenueWeek, revenueMonth,
    labourToday, labourWeek, labourMonth,
    kitchenToday, kitchenWeek, kitchenMonth,
    gbp,
    latestAudit,
    latestDiner,
    todos,
    tasks,
    stockTake,
    meatUse,
  } = props

  return (
    // -m-4 escapes the AppShell <main> p-4 padding so we own the full canvas
    <div
      className="-m-4 min-h-[calc(100vh-0px)]"
      style={{ background: '#C8B89A' }}
    >
      {/* Narrow centred column — mobile-style on all viewports */}
      <div className="mx-auto w-full max-w-[430px] flex flex-col min-h-screen">

        {/* ── Header ───────────────────────────────────────────────────── */}
        <header className="px-5 pt-6 pb-5 border-b-2 border-[#171717]">
          <div className="font-brand text-[11px] tracking-[0.25em] uppercase text-[#171717] mb-1">
            Killer Kockpit
          </div>
          <div className="font-brand text-2xl font-black text-[#AD3919] leading-tight tracking-tight">
            {storeName}
          </div>
          <div className="text-[11px] text-[#171717] mt-1">
            Store Manager Dashboard
          </div>
          <div className="text-[11px] text-[#171717] mt-0.5">
            {new Date().toLocaleDateString('en-GB', {
              timeZone: 'Europe/Copenhagen',
              day: 'numeric', month: 'short', year: 'numeric',
            })}
          </div>
        </header>

        {/* ── Body ─────────────────────────────────────────────────────── */}
        <div className="flex-1 px-5 pb-10 pt-4 flex flex-col gap-5">

          {/* Store Performance */}
          <section>
            <SectionHeading>Store Performance</SectionHeading>
            <StorePerformance
              revenueToday={revenueToday}
              revenueWeek={revenueWeek}
              revenueMonth={revenueMonth}
              labourToday={labourToday}
              labourWeek={labourWeek}
              labourMonth={labourMonth}
              kitchenToday={kitchenToday}
              kitchenWeek={kitchenWeek}
              kitchenMonth={kitchenMonth}
            />
          </section>

          {/* Customer Feedback */}
          <section>
            <SectionHeading>Customer Feedback</SectionHeading>
            <CustomerFeedback gbp={gbp} />
          </section>

          {/* Latest Checks */}
          <section>
            <SectionHeading>Latest Checks</SectionHeading>
            <LatestChecks latestAudit={latestAudit} latestDiner={latestDiner} />
          </section>

          {/* My To-Dos */}
          <section>
            <SectionHeading>My To-Dos</SectionHeading>
            <MyTodos todos={todos} />
          </section>

          {/* My Tasks */}
          <section>
            <SectionHeading>My Tasks</SectionHeading>
            <MyTasks tasks={tasks} />
          </section>

          {/* Store Routines */}
          <section>
            <SectionHeading>Store Routines</SectionHeading>
            <StoreRoutines stockTake={stockTake} meatUse={meatUse} />
          </section>

        </div>
      </div>
    </div>
  )
}
