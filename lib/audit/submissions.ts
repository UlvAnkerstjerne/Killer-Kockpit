import { createClient } from '@/lib/supabase/server'

export type AuditHealthStatus = 'GREEN' | 'LIGHT_GREEN' | 'YELLOW' | 'ORANGE' | 'RED'

export interface ActiveLocation {
  id: string
  name: string
}

export async function getActiveLocations(): Promise<ActiveLocation[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('locations')
    .select('id, name')
    .eq('active', true)
    .order('name')
  return (data ?? []) as ActiveLocation[]
}

export interface AuditSubmissionRow {
  id: string
  status: 'in_progress' | 'submitted'
  score_pct: number | null
  core_score_pct: number | null
  red_flag_count: number | null
  audit_status: AuditHealthStatus | null
  created_at: string
  submitted_at: string | null
  location_id: string
  location_name: string
  auditor_name: string
}

export async function getOperationalAuditSubmissions(): Promise<{
  submissions: AuditSubmissionRow[]
  templateId: string | null
  error: string | null
}> {
  const supabase = await createClient()

  const { data: template, error: tErr } = await supabase
    .from('audit_templates')
    .select('id')
    .eq('audit_key', 'operational_audit')
    .eq('status', 'published')
    .single()

  if (tErr || !template) {
    return { submissions: [], templateId: null, error: 'no_published_template' }
  }

  const { data, error } = await supabase
    .from('audit_submissions')
    .select(`
      id, status, score_pct, core_score_pct, red_flag_count, audit_status,
      created_at, submitted_at, location_id,
      locations!location_id ( name ),
      app_users!auditor_user_id ( display_name )
    `)
    .eq('template_id', template.id)
    .order('created_at', { ascending: false })

  if (error) {
    return { submissions: [], templateId: template.id, error: error.message }
  }

  const submissions: AuditSubmissionRow[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    status: row.status as AuditSubmissionRow['status'],
    score_pct: row.score_pct as number | null,
    core_score_pct: row.core_score_pct as number | null,
    red_flag_count: row.red_flag_count as number | null,
    audit_status: row.audit_status as AuditHealthStatus | null,
    created_at: row.created_at as string,
    submitted_at: row.submitted_at as string | null,
    location_id: row.location_id as string,
    location_name: (row.locations as { name: string } | null)?.name ?? '—',
    auditor_name: (row.app_users as { display_name: string } | null)?.display_name ?? '—',
  }))

  return { submissions, templateId: template.id, error: null }
}
