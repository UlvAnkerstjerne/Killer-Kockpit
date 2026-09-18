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
import {
  loadSelectedStoreData,
  selectAssignedStore,
  type AssignedStore,
} from '@/lib/store/dashboard-selection'
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

async function resolveAssignedStoreLocations(userId: string): Promise<AssignedStore[]> {
  const service = createServiceClient()

  // 1. Find the active employee record linked to this authenticated user
  const { data: emp } = await service
    .from('employees')
    .select('id')
    .eq('linked_user_id', userId)
    .in('employment_status', ['active', 'probation'])
    .limit(1)
    .single()

  if (!emp) return []
  const employeeId = (emp as { id: string }).id

  // 2. Find active location assignments for this employee
  const { data: locRows } = await service
    .from('employee_locations')
    .select('location_id')
    .eq('employee_id', employeeId)
    .eq('active', true)

  const locationIds = ((locRows ?? []) as { location_id: string }[]).map(r => r.location_id)
  if (locationIds.length === 0) return []

  // 3. Resolve to active canonical locations
  const { data: locs } = await service
    .from('locations')
    .select('id, name, short_name')
    .in('id', locationIds)
    .eq('active', true)
    .order('name')

  return (locs ?? []) as AssignedStore[]
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchTodos(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<DashboardTodo[]> {
  const { data } = await supabase
    .from('todos')
    .select('id, title, completed_at, priority, sort_order')
    .eq('user_id', userId)
    .is('cancelled_at', null)
    .order('sort_order', { ascending: true, nullsFirst: true })
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
  locationId: string,
): Promise<DashboardAudit | null> {
  // Uses service client: MEMBER role cannot read audit_submissions for audits
  // they didn't personally submit, but the dashboard needs the latest store audit
  // regardless of auditor. locationId comes from the authorised selection gate.
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

  const { data } = await service
    .from('audit_submissions')
    .select('id, score_pct, audit_status, submitted_at, locations!location_id (name)')
    .eq('template_id', (template as { id: string }).id)
    .eq('status', 'submitted')
    .eq('location_id', locationId)
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
  locationId: string,
): Promise<DashboardDiner | null> {
  // diner_submissions has no authenticated SELECT RLS policies — service client
  // is required unconditionally. locationId comes from the authorised selection gate.
  const service = createServiceClient()

  const { data: invs } = await service
    .from('diner_invitations')
    .select('id')
    .eq('location_id', locationId)

  const invitationIds = ((invs ?? []) as { id: string }[]).map(i => i.id)
  if (invitationIds.length === 0) return null

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

  const { data } = await service
    .from('diner_submissions')
    .select(`
      id, score_pct, diner_status, submitted_at,
      diner_invitations!invitation_id (
        location_id,
        locations!location_id (name)
      )
    `)
    .eq('status', 'submitted')
    .in('invitation_id', invitationIds)
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

// ─── Safe pre-dashboard states ────────────────────────────────────────────────
//
// Rendered server-side before a location has been authorised and selected.
// No dashboard queries or adapter reads are executed in either path.

function StoreFallback() {
  return (
    <div className="-m-4 min-h-[calc(100vh-0px)]" style={{ background: '#C8B89A' }}>
      <div className="mx-auto w-full max-w-[430px] flex flex-col min-h-screen">
        <header className="px-5 pt-6 pb-5 border-b-2 border-[#171717]">
          <div className="font-brand text-[11px] tracking-[0.25em] uppercase text-[#171717] mb-1">
            Killer Kockpit
          </div>
          <div className="text-xl font-black text-[#8D795F] leading-tight tracking-tight">
            No store assigned
          </div>
          <div className="text-[11px] text-[#171717] mt-1">Store Manager Dashboard</div>
        </header>
        <div className="flex-1 px-5 pt-8">
          <p className="text-sm text-[#171717] leading-relaxed">
            Ask your manager to assign your store in Kockpit.
          </p>
        </div>
      </div>
    </div>
  )
}

function StoreSelectionPrompt({
  locations,
  invalidRequest,
}: {
  locations: AssignedStore[]
  invalidRequest: boolean
}) {
  return (
    <div className="-m-4 min-h-[calc(100vh-0px)]" style={{ background: '#C8B89A' }}>
      <div className="mx-auto w-full max-w-[430px] flex flex-col min-h-screen">
        <header className="px-5 pt-6 pb-5 border-b-2 border-[#171717]">
          <div className="font-brand text-[11px] tracking-[0.25em] uppercase text-[#171717] mb-1">
            Killer Kockpit
          </div>
          <div className="text-xl font-black text-[#8D795F] leading-tight tracking-tight">
            Choose a store
          </div>
          <div className="text-[11px] text-[#171717] mt-1">Store Manager Dashboard</div>
        </header>
        <div className="flex-1 px-5 pt-8 pb-10">
          <p className="text-sm text-[#171717] leading-relaxed mb-5">
            {invalidRequest
              ? 'That store is not assigned to you. Choose one of your assigned stores.'
              : 'Choose the store you want to open.'}
          </p>
          <div className="flex flex-col gap-2">
            {locations.map(location => (
              <a
                key={location.id}
                href={`/store?location=${encodeURIComponent(location.id)}`}
                className="flex items-center gap-3 border-2 border-[#171717] px-4 py-4 bg-[#D2C3A7] hover:bg-[#C8B89A] transition-colors"
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-black text-[#171717] leading-tight">
                    {location.short_name}
                  </span>
                  <span className="block text-[10px] text-[#8D795F] mt-1">
                    {location.name}
                  </span>
                </span>
                <span aria-hidden="true" className="text-lg font-black text-[#171717]">›</span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function StorePage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string | string[] }>
}) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const assignedLocations = await resolveAssignedStoreLocations(user.id)
  const locationParam = (await searchParams).location
  const requestedLocationId = locationParam === undefined
    ? null
    : typeof locationParam === 'string' && locationParam.length > 0
      ? locationParam
      : '__invalid_location_request__'
  const storeSelection = selectAssignedStore(assignedLocations, requestedLocationId)

  if (storeSelection.state === 'no_store') {
    return <StoreFallback />
  }

  if (storeSelection.state === 'selection_required') {
    return (
      <StoreSelectionPrompt
        locations={storeSelection.locations}
        invalidRequest={storeSelection.invalidRequest}
      />
    )
  }

  // The selected location has now been checked against this user's assignments.
  const { location } = storeSelection
  const supabase = await createClient()

  const dashboardData = await loadSelectedStoreData(storeSelection, user.id, {
    fetchTodos: userId => fetchTodos(supabase, userId),
    fetchTasks: userId => fetchTasks(supabase, userId),
    fetchLatestAudit,
    fetchLatestDiner,
  })

  if (!dashboardData) return null
  const { todos, tasks, latestAudit, latestDiner } = dashboardData

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
      storeOptions={storeSelection.locations}
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
