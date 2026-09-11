/**
 * lib/reports/generate-diner-pdf.ts
 *
 * Mystery Diner PDF generation, data loading, and shared input types.
 * Server-only — never import from client components.
 *
 * Exports:
 *   DinerPdfInput / DinerPdfCheckpoint / DinerPdfResponse — data contract
 *   generateDinerPdf(input)          — renders PDF buffer from pre-loaded data
 *   loadDinerPdfData(submissionId)   — loads all required data from DB
 *   buildDinerPdfFilename(loc, date) — canonical filename helper
 */

import { renderToBuffer } from '@react-pdf/renderer'
import { DinerReportDocument } from './diner-report'
import { createServiceClient } from '@/lib/supabase/server'

// ─── Shared input types ───────────────────────────────────────────────────────

export interface DinerPdfCheckpoint {
  id:            string
  orderIndex:    number
  section:       string
  label:         string
  type:          'scored' | 'gold_star' | 'waiting_time' | 'informational'
  isCritical:    boolean
  isConditional: boolean
}

export interface DinerPdfResponse {
  checkpointId: string
  result:       'pass' | 'fail' | 'na' | null
  notes:        string | null
}

export interface DinerPdfInput {
  locationName:      string
  dinerName:         string
  submittedAt:       string  // ISO timestamp
  scorePct:          number | null
  criticalFailCount: number
  goldStarCount:     number
  waitingTimeBand:   string | null
  finalStatus:       string | null  // 'GREEN' | 'YELLOW' | 'RED'
  checkpoints:       DinerPdfCheckpoint[]
  responses:         DinerPdfResponse[]
}

// ─── Filename helper ──────────────────────────────────────────────────────────

/**
 * Builds the canonical PDF filename.
 * Format: Mystery-Diner-{Store}-{YYYY-MM-DD}.pdf
 */
export function buildDinerPdfFilename(locationName: string, submittedAt: string): string {
  // ASCII-only safe for HTTP Content-Disposition headers
  const safeLoc = locationName
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
  const dateStr = new Date(submittedAt).toISOString().slice(0, 10)  // YYYY-MM-DD
  return `Mystery-Diner-${safeLoc}-${dateStr}.pdf`
}

// ─── PDF generator ────────────────────────────────────────────────────────────

/**
 * Renders a DinerPdfInput as a PDF buffer.
 * Throws on render failure — callers should catch and handle gracefully.
 */
export async function generateDinerPdf(
  input:       DinerPdfInput,
  generatedAt?: string,
): Promise<Buffer> {
  const buf = await renderToBuffer(
    <DinerReportDocument input={input} generatedAt={generatedAt} />
  )
  return Buffer.from(buf)
}

// ─── Data loader (for download route) ────────────────────────────────────────

/**
 * Loads all data required to generate a Mystery Diner PDF from a submission ID.
 * Returns null when the submission does not exist or has not been submitted.
 * Uses service_role — no RLS on diner tables.
 */
export async function loadDinerPdfData(submissionId: string): Promise<DinerPdfInput | null> {
  const db = createServiceClient()

  const { data: sub } = await db
    .from('diner_submissions')
    .select('id, invitation_id, template_id, submitted_at, score_pct, critical_fail_count, gold_star_count, waiting_time_band, final_status')
    .eq('id', submissionId)
    .eq('status', 'submitted')
    .maybeSingle()

  if (!sub) return null

  const [{ data: inv }, { data: checkpointRows }, { data: responseRows }] = await Promise.all([
    db
      .from('diner_invitations')
      .select('diner_name, locations ( name )')
      .eq('id', sub.invitation_id as string)
      .maybeSingle(),
    db
      .from('diner_checkpoints')
      .select('id, order_index, section, label, type, is_critical, is_conditional')
      .eq('template_id', sub.template_id as string)
      .order('order_index', { ascending: true }),
    db
      .from('diner_responses')
      .select('checkpoint_id, result, notes')
      .eq('submission_id', submissionId),
  ])

  const locationName = (inv?.locations as unknown as { name: string } | null)?.name ?? '—'
  const dinerName    = (inv?.diner_name as string | null) ?? '—'

  return {
    locationName,
    dinerName,
    submittedAt:       sub.submitted_at as string,
    scorePct:          sub.score_pct as number | null,
    criticalFailCount: (sub.critical_fail_count as number | null) ?? 0,
    goldStarCount:     (sub.gold_star_count as number | null) ?? 0,
    waitingTimeBand:   sub.waiting_time_band as string | null,
    finalStatus:       sub.final_status as string | null,
    checkpoints: (checkpointRows ?? []).map(c => ({
      id:            c.id as string,
      orderIndex:    c.order_index as number,
      section:       c.section as string,
      label:         c.label as string,
      type:          c.type as DinerPdfCheckpoint['type'],
      isCritical:    c.is_critical as boolean,
      isConditional: c.is_conditional as boolean,
    })),
    responses: (responseRows ?? []).map(r => ({
      checkpointId: r.checkpoint_id as string,
      result:       (r.result as 'pass' | 'fail' | 'na' | null) ?? null,
      notes:        (r.notes as string | null) ?? null,
    })),
  }
}
