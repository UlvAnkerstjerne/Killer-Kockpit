import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
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
// The current data architecture does not have a canonical user→location mapping
// on app_users.  As a temporary boundary, we fetch the first active location
// (alphabetically) and use it as the store context.
//
// TODO: when a user_location_id or canonical_location_id column is added to
// app_users, replace this fallback with a direct lookup.

async function resolveStoreName(supabase: Awaited<ReturnType<typeof createClient>>): Promise<string> {
  const { data } = await supabase
    .from('locations')
    .select('name')
    .eq('active', true)
    .order('name')
    .limit(1)
    .single()
  return (data as { name: string } | null)?.name ?? 'Killer Kebab'
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
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<DashboardAudit | null> {
  // Find the operational_audit template
  const { data: template } = await supabase
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

  const { data } = await supabase
    .from('audit_submissions')
    .select('id, score_pct, audit_status, submitted_at, locations!location_id (name)')
    .eq('template_id', (template as { id: string }).id)
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false })
    .limit(1)
    .single()

  if (!data) return null

  const raw = data as RawAudit
  const loc = Array.isArray(raw.locations) ? raw.locations[0] : raw.locations
  return {
    id:           raw.id,
    score_pct:    raw.score_pct,
    audit_status: raw.audit_status,
    submitted_at: raw.submitted_at,
    location_name: loc?.name ?? '—',
  }
}

async function fetchLatestDiner(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<DashboardDiner | null> {
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

  const { data } = await supabase
    .from('diner_submissions')
    .select(`
      id, score_pct, diner_status, submitted_at,
      diner_invitations!invitation_id (
        location_id,
        locations!location_id (name)
      )
    `)
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false })
    .limit(1)
    .single()

  if (!data) return null

  const raw = data as RawDiner
  const inv = Array.isArray(raw.diner_invitations) ? raw.diner_invitations[0] : raw.diner_invitations
  const loc = inv ? (Array.isArray(inv.locations) ? inv.locations[0] : inv.locations) : null

  return {
    id:           raw.id,
    score_pct:    raw.score_pct,
    status:       raw.diner_status,
    submitted_at: raw.submitted_at,
    location_name: loc?.name ?? null,
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function StorePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const supabase = await createClient()

  const [storeName, todos, tasks, latestAudit, latestDiner] = await Promise.all([
    resolveStoreName(supabase),
    fetchTodos(supabase, user.id),
    fetchTasks(supabase, user.id),
    fetchLatestAudit(supabase),
    fetchLatestDiner(supabase),
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
      storeName={storeName}
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
