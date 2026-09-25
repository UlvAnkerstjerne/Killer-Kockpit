import { createClient } from '@/lib/supabase/server'

export type AuditHealthStatus = 'GREEN' | 'LIGHT_GREEN' | 'YELLOW' | 'ORANGE' | 'RED'

/** Protocol-level config read from the published audit_template. */
export interface AuditTemplateConfig {
  requiresBusyness:        boolean
  requiresFailureContext:  boolean
  requiresManagerOnDuty:   boolean
}

/** Protocol-specific scoring labels and behaviour from scoring_config JSONB. */
export interface ScoringConfig {
  secondaryLabel:     string   // "Core Standards" | "Critical"
  secondaryShort:     string   // "Core" | "Critical"
  secondaryFailLabel: string   // "Red Flags" | "Critical Failures"
  secondaryFailShort: string   // "RF" | "CF"
  hasRedFlags:        boolean  // true for Operational Audit, false for Airport
  rfOverridesStatus:  boolean  // true for Operational Audit
  rfBadgeStyle:       string   // "red_flag" | "critical"
}

const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  secondaryLabel: 'Core Standards', secondaryShort: 'Core',
  secondaryFailLabel: 'Red Flags', secondaryFailShort: 'RF',
  hasRedFlags: true, rfOverridesStatus: true, rfBadgeStyle: 'red_flag',
}

export function parseScoringConfig(raw: Record<string, unknown> | null): ScoringConfig {
  if (!raw) return DEFAULT_SCORING_CONFIG
  return {
    secondaryLabel:     (raw.secondary_label as string)      ?? DEFAULT_SCORING_CONFIG.secondaryLabel,
    secondaryShort:     (raw.secondary_short as string)      ?? DEFAULT_SCORING_CONFIG.secondaryShort,
    secondaryFailLabel: (raw.secondary_fail_label as string) ?? DEFAULT_SCORING_CONFIG.secondaryFailLabel,
    secondaryFailShort: (raw.secondary_fail_short as string) ?? DEFAULT_SCORING_CONFIG.secondaryFailShort,
    hasRedFlags:        (raw.has_red_flags as boolean)        ?? DEFAULT_SCORING_CONFIG.hasRedFlags,
    rfOverridesStatus:  (raw.rf_overrides_status as boolean)  ?? DEFAULT_SCORING_CONFIG.rfOverridesStatus,
    rfBadgeStyle:       (raw.rf_badge_style as string)       ?? DEFAULT_SCORING_CONFIG.rfBadgeStyle,
  }
}

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
  core_score_fail: number | null
  red_flag_count: number | null
  audit_status: AuditHealthStatus | null
  created_at: string
  visited_at: string | null
  busyness: string | null
  submitted_at: string | null
  location_id: string
  location_name: string
  auditor_name: string
}

export async function getOperationalAuditSubmissions(): Promise<{
  submissions: AuditSubmissionRow[]
  templateId: string | null
  templateConfig: AuditTemplateConfig | null
  error: string | null
}> {
  return getAuditSubmissionsByKey('operational_audit')
}

/**
 * Fetch submissions across ALL template versions for a given audit_key.
 * Historical submissions referencing retired templates are included.
 * The templateConfig and scoringConfig come from the currently published version.
 */
export async function getAuditSubmissionsByKey(auditKey: string): Promise<{
  submissions: AuditSubmissionRow[]
  templateId: string | null
  templateConfig: AuditTemplateConfig | null
  scoringConfig: ScoringConfig
  error: string | null
}> {
  const supabase = await createClient()

  // Get the published template for config (used by new audits + UI config)
  const { data: published, error: tErr } = await supabase
    .from('audit_templates')
    .select('id, requires_busyness, requires_failure_context, requires_manager_on_duty, scoring_config')
    .eq('audit_key', auditKey)
    .eq('status', 'published')
    .single()

  if (tErr || !published) {
    return { submissions: [], templateId: null, templateConfig: null, scoringConfig: DEFAULT_SCORING_CONFIG, error: 'no_published_template' }
  }

  const templateConfig: AuditTemplateConfig = {
    requiresBusyness:       published.requires_busyness as boolean,
    requiresFailureContext: published.requires_failure_context as boolean,
    requiresManagerOnDuty:  published.requires_manager_on_duty as boolean,
  }

  const scoringConfig = parseScoringConfig(published.scoring_config as Record<string, unknown> | null)

  // Get ALL template IDs for this audit_key (published + retired)
  const { data: allTemplates } = await supabase
    .from('audit_templates')
    .select('id')
    .eq('audit_key', auditKey)

  const templateIds = (allTemplates ?? []).map(t => t.id as string)
  if (templateIds.length === 0) {
    return { submissions: [], templateId: published.id, templateConfig, scoringConfig, error: null }
  }

  // Fetch submissions across all versions
  const { data, error } = await supabase
    .from('audit_submissions')
    .select(`
      id, status, score_pct, core_score_pct, core_score_fail, red_flag_count, audit_status,
      created_at, visited_at, busyness, submitted_at, location_id,
      locations!location_id ( name ),
      app_users!auditor_user_id ( display_name )
    `)
    .in('template_id', templateIds)
    .order('created_at', { ascending: false })

  if (error) {
    return { submissions: [], templateId: published.id, templateConfig, scoringConfig, error: error.message }
  }

  const submissions: AuditSubmissionRow[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    status: row.status as AuditSubmissionRow['status'],
    score_pct: row.score_pct as number | null,
    core_score_pct: row.core_score_pct as number | null,
    core_score_fail: row.core_score_fail as number | null,
    red_flag_count: row.red_flag_count as number | null,
    audit_status: row.audit_status as AuditHealthStatus | null,
    created_at: row.created_at as string,
    visited_at: row.visited_at as string | null,
    busyness: row.busyness as string | null,
    submitted_at: row.submitted_at as string | null,
    location_id: row.location_id as string,
    location_name: (row.locations as { name: string } | null)?.name ?? '—',
    auditor_name: (row.app_users as { display_name: string } | null)?.display_name ?? '—',
  }))

  return { submissions, templateId: published.id, templateConfig, scoringConfig, error: null }
}
