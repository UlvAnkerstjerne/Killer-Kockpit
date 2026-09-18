import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import {
  getRevenueDemoData,
  getLabourDemoData,
  getKitchenDemoData,
  getGbpDemoData,
  getStockTakeDemoData,
  getMeatUseDemoData,
} from '@/lib/store/adapter'
import StoreDashboardClient from './StoreDashboardClient'
import type { DashboardTodo, DashboardTask, DashboardAudit, DashboardDiner } from './StoreDashboardClient'

export const dynamic = 'force-dynamic'

// ─── Location resolution ──────────────────────────────────────────────────────
//
// Chain: app_users → employees.linked_user_id → employee_locations → locations
//
// All three tables (employees, employee_locations, locations) have RLS SELECT
// policies restricted to SUPER_ADMIN and UM — a MEMBER cannot traverse this
// chain with their own session credentials.
//
// The service client is used narrowly here for identity/location lookup only.
// Authorization is established by anchoring to userId from getCurrentUser(),
// which is derived from the authenticated session (not caller-supplied).
// We only ever read data belonging to that specific user.

type StoreLocation = { id: string; name: string; short_name: string }

type StoreResolution =
  | { state: 'resolved'; location: StoreLocation }
  | { state: 'no_store' }
  | { state: 'multiple_stores'; count: number }

async function resolveStoreLocation(userId: string): Promise<StoreResolution> {
  const service = createServiceClient()

  // 1. Find the active employee record linked to this authenticated user
  const { data: emp } = await service
    .from('employees')
    .select('id')
    .eq('linked_user_id', userId)
    .in('employment_status', ['active', 'probation'])
    .limit(1)
    .single()

  if (!emp) return { state: 'no_store' }
  const employeeId = (emp as { id: string }).id

  // 2. Find active location assignments for this employee
  const { data: locRows } = await service
    .from('employee_locations')
    .select('location_id')
    .eq('employee_id', employeeId)
    .eq('active', true)

  const locationIds = ((locRows ?? []) as { location_id: string }[]).map(r => r.location_id)
  if (locationIds.length === 0) return { state: 'no_store' }

  // 3. Resolve to active canonical locations
  const { data: locs } = await service
    .from('locations')
    .select('id, name, short_name')
    .in('id', locationIds)
    .eq('active', true)

  const active = (locs ?? []) as StoreLocation[]
  if (active.length === 0) return { state: 'no_store' }
  if (active.length > 1)   return { state: 'multiple_stores', count: active.length }
  return { state: 'resolved', location: active[0] }
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchTodos(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<DashboardTodo[]> {
  const { data } = await supabase
    .from('todos')
    .select('id, title, completed_at, priority')
    .eq('user_id', userId)
    .is('cancelled_at', null)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(30)
  return (data ?? []) as DashboardTodo[]
}

async function fetchTasks(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<DashboardTask[]> {
  const { data } = await supabase
    .from('tasks')
    .select('id, title, status, due_at, creator:created_by_user_id (display_name)')
    .eq('owner_user_id', userId)
    .is('archived_at', null)
    .not('status', 'in', '("done","cancelled")')
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('priority', { ascending: true })
    .limit(20)

  type RawTask = {
    id: string
    title: string
    status: string
    due_at: string | null
    creator: { display_name: string } | Array<{ display_name: string }> | null
  }

  return ((data ?? []) as RawTask[]).map((t) => {
    const c = Array.isArray(t.creator) ? t.creator[0] : t.creator
    return {
      id:         t.id,
      title:      t.title,
      status:     t.status,
      due_at:     t.due_at,
      created_by: c?.display_name ?? null,
    }
  })
}

async function fetchLatestAudit(
  locationId: string | null,
): Promise<DashboardAudit | null> {
  // Uses service client: MEMBER role cannot read audit_submissions for audits
  // they didn't personally submit, but the dashboard needs the latest store audit
  // regardless of auditor. locationId comes from the authorised resolveStoreLocation().
  const service = createServiceClient()

  const { data: template } = await service
    .from('audit_templates')
    .select('id')
    .eq('audit_key', 'operational_audit')
    .eq('status', 'published')
    .single()

  if (!template) return null

  type RawAudit = {
    id: string
    score_pct: number | null
    audit_status: string | null
    submitted_at: string | null
    locations: { name: string } | Array<{ name: string }> | null
  }

  let query = service
    .from('audit_submissions')
    .select('id, score_pct, audit_status, submitted_at, locations!location_id (name)')
    .eq('template_id', (template as { id: string }).id)
    .eq('status', 'submitted')

  if (locationId) {
    query = query.eq('location_id', locationId)
  }

  const { data } = await query
    .order('submitted_at', { ascending: false })
    .limit(1)
    .single()

  if (!data) return null

  const raw = data as RawAudit
  const loc = Array.isArray(raw.locations) ? raw.locations[0] : raw.locations
  return {
    id:            raw.id,
    score_pct:     raw.score_pct,
    audit_status:  raw.audit_status,
    submitted_at:  raw.submitted_at,
    location_name: loc?.name ?? '—',
  }
}

async function fetchLatestDiner(
  locationId: string | null,
): Promise<DashboardDiner | null> {
  // diner_submissions has no authenticated SELECT RLS policies — service client
  // is required unconditionally. locationId comes from resolveStoreLocation().
  const service = createServiceClient()

  // When a location is known, pre-filter by invitation IDs for that location
  // to scope results to this store only.
  let invitationIds: string[] | null = null
  if (locationId) {
    const { data: invs } = await service
      .from('diner_invitations')
      .select('id')
      .eq('location_id', locationId)

    invitationIds = ((invs ?? []) as { id: string }[]).map(i => i.id)
    if (invitationIds.length === 0) return null
  }

  type RawDiner = {
    id: string
    score_pct: number | null
    diner_status: string | null
    submitted_at: string | null
    diner_invitations: {
      location_id: string | null
      locations: { name: string } | Array<{ name: string }> | null
    } | Array<{
      location_id: string | null
      locations: { name: string } | Array<{ name: string }> | null
    }> | null
  }

  let query = service
    .from('diner_submissions')
    .select(`
      id, score_pct, diner_status, submitted_at,
      diner_invitations!invitation_id (
        location_id,
        locations!location_id (name)
      )
    `)
    .eq('status', 'submitted')

  if (invitationIds) {
    query = query.in('invitation_id', invitationIds)
  }

  const { data } = await query
    .order('submitted_at', { ascending: false })
    .limit(1)
    .single()

  if (!data) return null

  const raw = data as RawDiner
  const inv = Array.isArray(raw.diner_invitations) ? raw.diner_invitations[0] : raw.diner_invitations
  const loc = inv ? (Array.isArray(inv.locations) ? inv.locations[0] : inv.locations) : null

  return {
    id:            raw.id,
    score_pct:     raw.score_pct,
    status:        raw.diner_status,
    submitted_at:  raw.submitted_at,
    location_name: loc?.name ?? null,
  }
}

// ─── Fallback UI (no-store / multiple-stores) ─────────────────────────────────
//
// Rendered server-side when location resolution yields 0 or 2+ locations.
// No store-specific queries (audit, diner, todos, tasks, revenue, GBP, routines)
// are executed in this path — the page is safe to render for any auth'd user.

function StoreFallback({ state }: { state: 'no_store' | 'multiple_stores' }) {
  const isNoStore = state === 'no_store'
  return (
    <div className="-m-4 min-h-[calc(100vh-0px)]" style={{ background: '#C8B89A' }}>
      <div className="mx-auto w-full max-w-[430px] flex flex-col min-h-screen">
        <header className="px-5 pt-6 pb-5 border-b-2 border-[#171717]">
          <div className="font-brand text-[11px] tracking-[0.25em] uppercase text-[#171717] mb-1">
            Killer Kockpit
          </div>
          <div className="text-xl font-black text-[#8D795F] leading-tight tracking-tight">
            {isNoStore ? 'No store assigned' : 'Multiple stores assigned'}
          </div>
          <div className="text-[11px] text-[#171717] mt-1">Store Manager Dashboard</div>
        </header>
        <div className="flex-1 px-5 pt-8">
          <p className="text-sm text-[#171717] leading-relaxed">
            {isNoStore
              ? 'Ask your manager to assign your store in Kockpit.'
              : 'This dashboard currently supports one assigned store. Ask your manager to update your store assignment.'}
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function StorePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // Resolve canonical store location first.
  // No store-specific queries run until exactly one location is confirmed.
  const storeResolution = await resolveStoreLocation(user.id)

  if (storeResolution.state !== 'resolved') {
    return <StoreFallback state={storeResolution.state} />
  }

  // ── Exactly one location resolved — safe to fetch store data ──────────────
  const { location } = storeResolution
  const supabase = await createClient()

  const [todos, tasks, latestAudit, latestDiner] = await Promise.all([
    fetchTodos(supabase, user.id),
    fetchTasks(supabase, user.id),
    fetchLatestAudit(location.id),
    fetchLatestDiner(location.id),
  ])

  // Adapter data (unwired — all from lib/store/adapter.ts)
  const revenueToday  = getRevenueDemoData('today')
  const revenueWeek   = getRevenueDemoData('week')
  const revenueMonth  = getRevenueDemoData('month')
  const labourToday   = getLabourDemoData('today')
  const labourWeek    = getLabourDemoData('week')
  const labourMonth   = getLabourDemoData('month')
  const kitchenToday  = getKitchenDemoData('today')
  const kitchenWeek   = getKitchenDemoData('week')
  const kitchenMonth  = getKitchenDemoData('month')
  const gbp           = getGbpDemoData()
  const stockTake     = getStockTakeDemoData()
  const meatUse       = getMeatUseDemoData()

  return (
    <StoreDashboardClient
      storeName={location.short_name}
      managerName={user.display_name}
      revenueToday={revenueToday}
      revenueWeek={revenueWeek}
      revenueMonth={revenueMonth}
      labourToday={labourToday}
      labourWeek={labourWeek}
      labourMonth={labourMonth}
      kitchenToday={kitchenToday}
      kitchenWeek={kitchenWeek}
      kitchenMonth={kitchenMonth}
      gbp={gbp}
      latestAudit={latestAudit}
      latestDiner={latestDiner}
      todos={todos}
      tasks={tasks}
      stockTake={stockTake}
      meatUse={meatUse}
    />
  )
}
