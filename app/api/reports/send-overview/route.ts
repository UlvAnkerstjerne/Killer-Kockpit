/**
 * POST /api/reports/send-overview
 *
 * Generates a combined executive overview PDF for the last N completed reports
 * and sends it to an arbitrary email address.
 * Management / KQC-authorized users only.
 *
 * Body:
 *   { system: 'audit' | 'ssp_cph' | 'diner', email: string, count: number, locationId?: string }
 *
 * Response: { ok: true } | { ok: false; error: string }
 *
 * count is clamped 1–50 server-side.
 * For ssp_cph, locationId is ignored (single location system).
 */

import { type NextRequest, NextResponse } from 'next/server'
import { getCurrentUser }        from '@/lib/auth'
import { canAccessQualityCheck } from '@/lib/permissions'
import { createServiceClient }   from '@/lib/supabase/server'
import { Resend }                from 'resend'
import { generateOverviewPdf, buildOverviewFilename } from '@/lib/reports/generate-overview-pdf'
import { fetchSSPCphDataDirect }  from '@/lib/kkc/ssp-cph'
import type { OverviewAuditRow, OverviewDinerRow, OverviewSspRow } from '@/lib/reports/generate-overview-pdf'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(body: object, status = 200) {
  return NextResponse.json(body, { status })
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY?.trim()
  return key ? new Resend(key) : null
}

function getFrom(): string {
  return process.env.RESEND_FROM?.trim() ?? 'Killer Kockpit <notifications@kockpit.killerkebab.com>'
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

async function logDelivery(
  db:            ReturnType<typeof createServiceClient>,
  reportType:    string,
  submissionKey: string,
  recipient:     string,
  senderUserId:  string,
  result:        { ok: true; resendId: string } | { ok: false; error: string },
): Promise<void> {
  await db.from('report_deliveries').insert({
    report_type:    reportType,
    submission_key: submissionKey,
    recipient,
    status:         result.ok ? 'sent' : 'failed',
    resend_id:      result.ok ? result.resendId : null,
    error:          result.ok ? null : result.error,
    sent_at:        result.ok ? new Date().toISOString() : null,
    is_manual:      true,
    sender_user_id: senderUserId,
  }).then(({ error }) => {
    if (error) console.error('[send-overview] Failed to log delivery:', error.message)
  })
}

// ─── Data loaders ──────────────────────────────────────────────────────────────

async function loadAuditRows(
  db:         ReturnType<typeof createServiceClient>,
  count:      number,
  locationId: string | null,
): Promise<{ rows: OverviewAuditRow[]; locationLabel: string }> {
  let q = db
    .from('audit_submissions')
    .select(`
      id, score_pct, core_score_pct, red_flag_count, audit_status, submitted_at,
      locations!location_id ( id, name )
    `)
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false })
    .limit(count)

  if (locationId) q = q.eq('location_id', locationId)

  const { data } = await q

  let locationLabel = 'All locations'
  if (locationId && (data ?? []).length > 0) {
    const loc = (data![0].locations as unknown as { name: string } | null)?.name
    if (loc) locationLabel = loc
  }

  const rows: OverviewAuditRow[] = (data ?? []).map(r => ({
    system:       'audit' as const,
    id:           r.id as string,
    date:         fmtDate(r.submitted_at as string),
    locationName: (r.locations as unknown as { name: string } | null)?.name ?? '—',
    overallPct:   r.score_pct !== null ? Math.round(r.score_pct as number) : null,
    corePct:      r.core_score_pct !== null ? Math.round(r.core_score_pct as number) : null,
    redFlagCount: (r.red_flag_count as number | null) ?? 0,
    auditStatus:  (r.audit_status as string | null) ?? null,
  }))

  return { rows, locationLabel }
}

async function loadDinerRows(
  db:         ReturnType<typeof createServiceClient>,
  count:      number,
  locationId: string | null,
): Promise<{ rows: OverviewDinerRow[]; locationLabel: string }> {
  // Load submissions with join to invitations for location/diner info
  const { data: subs } = await db
    .from('diner_submissions')
    .select('id, score_pct, critical_fail_count, gold_star_count, waiting_time_band, final_status, submitted_at, invitation_id')
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false })
    .limit(count * 3)  // over-fetch to allow post-filter by location

  if (!subs || subs.length === 0) return { rows: [], locationLabel: 'All locations' }

  const invIds = subs.map(s => s.invitation_id as string)
  const { data: invs } = await db
    .from('diner_invitations')
    .select('id, diner_name, location_id, locations ( name )')
    .in('id', invIds)

  const invMap = new Map((invs ?? []).map((i: any) => [i.id as string, i]))

  let locationLabel = 'All locations'
  const rows: OverviewDinerRow[] = []

  for (const sub of subs) {
    const inv = invMap.get(sub.invitation_id as string) as any
    const locId   = inv?.location_id as string | null
    const locName = (inv?.locations as { name: string } | null)?.name ?? null

    // Apply location filter
    if (locationId && locId !== locationId) continue

    rows.push({
      system:            'diner' as const,
      id:                sub.id as string,
      date:              fmtDate(sub.submitted_at as string),
      locationName:      locName,
      scorePct:          sub.score_pct !== null ? Math.round(sub.score_pct as number) : null,
      finalStatus:       sub.final_status as string | null,
      criticalFailCount: (sub.critical_fail_count as number | null) ?? 0,
      goldStarCount:     (sub.gold_star_count as number | null) ?? 0,
      waitingTimeBand:   sub.waiting_time_band as string | null,
    })

    if (rows.length >= count) break
  }

  if (locationId) {
    const first = rows.at(0)
    if (first?.locationName) locationLabel = first.locationName
  }

  return { rows, locationLabel }
}

async function loadSspRows(
  count: number,
): Promise<{ rows: OverviewSspRow[]; locationLabel: string }> {
  let data: Awaited<ReturnType<typeof fetchSSPCphDataDirect>>
  try {
    data = await fetchSSPCphDataDirect()
  } catch (err) {
    throw new Error(`Failed to load SSP/CPH data: ${err instanceof Error ? err.message : String(err)}`)
  }

  const scores = data.scores.slice(-count)

  const rows: OverviewSspRow[] = scores.map(s => ({
    system:           'ssp_cph' as const,
    id:               s.timestamp,
    date:             s.date,
    overallScore:     s.overallScore,
    criticalScore:    s.criticalScore,
    criticalFailures: s.criticalFailures,
  }))

  return { rows, locationLabel: 'SSP / CPH Airport' }
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Auth
  const user = await getCurrentUser()
  if (!user) return json({ ok: false, error: 'Not authenticated' }, 401)
  if (!canAccessQualityCheck(user.role)) return json({ ok: false, error: 'Forbidden' }, 403)

  let body: { system?: unknown; email?: unknown; count?: unknown; locationId?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400)
  }

  const { system, email, count: rawCount, locationId: rawLocId } = body

  if (system !== 'audit' && system !== 'ssp_cph' && system !== 'diner') {
    return json({ ok: false, error: 'system must be audit, ssp_cph, or diner' }, 400)
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return json({ ok: false, error: 'A valid email address is required' }, 400)
  }
  const count = typeof rawCount === 'number'
    ? Math.min(50, Math.max(1, Math.floor(rawCount)))
    : 10
  const locationId = typeof rawLocId === 'string' && rawLocId ? rawLocId : null

  const db = createServiceClient()

  // Load rows
  let rows: (OverviewDinerRow | OverviewSspRow | { system: 'audit' } & OverviewAuditRow)[] = []
  let locationLabel = 'All locations'

  try {
    if (system === 'audit') {
      const res = await loadAuditRows(db, count, locationId)
      rows = res.rows
      locationLabel = res.locationLabel
    } else if (system === 'diner') {
      const res = await loadDinerRows(db, count, locationId)
      rows = res.rows
      locationLabel = res.locationLabel
    } else {
      const res = await loadSspRows(count)
      rows = res.rows
      locationLabel = res.locationLabel
    }
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : 'Failed to load data' }, 500)
  }

  if (rows.length === 0) {
    return json({ ok: false, error: 'No completed reports found matching your selection' }, 404)
  }

  // Generate overview PDF
  let pdfBuf: Buffer
  try {
    pdfBuf = await generateOverviewPdf({
      system:        system as 'audit' | 'ssp_cph' | 'diner',
      locationLabel,
      count:         rows.length,
      rows:          rows as any,
      generatedAt:   new Date().toISOString(),
    })
  } catch (err) {
    return json({ ok: false, error: `PDF error: ${err instanceof Error ? err.message : String(err)}` }, 500)
  }

  // Build subject and filename
  const systemLabels: Record<string, string> = {
    audit:   'Audit',
    diner:   'Mystery Diner',
    ssp_cph: 'KQC SSP/CPH',
  }
  const systemLabel = systemLabels[system] ?? system
  const locPart     = locationId ? ` — ${locationLabel}` : ''
  const subject     = `${systemLabel} overview${locPart} — Last ${rows.length} reports`
  const filename    = buildOverviewFilename(system, locationLabel, rows.length)

  const resend = getResend()
  if (!resend) {
    await logDelivery(db, `manual_overview_${system}`, filename, email, user.id, { ok: false, error: 'RESEND_API_KEY not configured' })
    return json({ ok: false, error: 'Email service not configured' }, 500)
  }

  let sendResult: { ok: true; resendId: string } | { ok: false; error: string }
  try {
    const { data, error } = await resend.emails.send({
      from:    getFrom(),
      to:      [email],
      subject,
      text:    `${systemLabel} overview attached — ${locationLabel} · ${rows.length} reports.\n\nSent by Killer Kockpit · Killer Kebab internal use only`,
      html:    `<p><strong>${systemLabel} overview attached</strong></p><p>${locationLabel} &middot; ${rows.length} reports</p><p style="color:#6b6760;font-size:12px;">Sent by <strong style="color:#AD3919">Killer Kockpit</strong> &middot; Killer Kebab internal use only</p>`,
      attachments: [{ filename, content: pdfBuf }],
    })
    if (error) {
      sendResult = { ok: false, error: `Resend error: ${error.message}` }
    } else {
      sendResult = { ok: true, resendId: data!.id }
    }
  } catch (err) {
    sendResult = { ok: false, error: `Send failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  await logDelivery(db, `manual_overview_${system}`, filename, email, user.id, sendResult)

  if (!sendResult.ok) {
    console.error(`[send-overview] ${system} → ${email}: ${sendResult.error}`)
    return json({ ok: false, error: sendResult.error }, 500)
  }

  return json({ ok: true })
}
