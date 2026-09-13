/**
 * POST /api/reports/send-single
 *
 * Manually sends one completed report to an arbitrary email address.
 * Management / KQC-authorized users only.
 *
 * Body: { system: 'audit' | 'ssp_cph' | 'diner', submissionId: string, email: string }
 * Response: { ok: true } | { ok: false; error: string }
 *
 * Manual sends are always allowed regardless of prior automated delivery —
 * they are logged in report_deliveries with is_manual=true so the automated
 * dedup index never fires.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { getCurrentUser }          from '@/lib/auth'
import { canAccessQualityCheck }   from '@/lib/permissions'
import { createServiceClient }     from '@/lib/supabase/server'
import { Resend }                  from 'resend'

// PDF generators
import { generateAuditPdf }                            from '@/lib/reports/generate-audit-pdf'
import { generateDinerPdf, loadDinerPdfData, buildDinerPdfFilename } from '@/lib/reports/generate-diner-pdf'
import { generateKKCPdf }                              from '@/lib/reports/generate-pdf'
import { fetchSSPCphDataDirect }                       from '@/lib/kkc/ssp-cph'
import { buildSubmissionDetail }                       from '@/lib/kkc/detail'

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
    if (error) console.error('[send-single] Failed to log delivery:', error.message)
  })
}

// ─── System-specific send handlers ────────────────────────────────────────────

async function sendAudit(
  submissionId: string,
  email:        string,
  db:           ReturnType<typeof createServiceClient>,
): Promise<{ ok: true; resendId: string } | { ok: false; error: string }> {
  const { data: sub } = await db
    .from('audit_submissions')
    .select(`
      id, score_pct, core_score_pct, red_flag_count, audit_status, submitted_at,
      final_done_well, final_focus_next, final_overall_comments,
      locations!location_id ( name ),
      app_users!auditor_user_id ( display_name )
    `)
    .eq('id', submissionId)
    .eq('status', 'submitted')
    .maybeSingle()

  if (!sub) return { ok: false, error: 'Audit not found or not submitted' }

  const { data: topActionRows } = await db
    .from('audit_top_actions')
    .select('sort_order, action, owner, deadline')
    .eq('submission_id', submissionId)
    .order('sort_order', { ascending: true })

  const locationName = (sub.locations as unknown as { name: string } | null)?.name ?? '—'
  const auditorName  = (sub.app_users as unknown as { display_name: string } | null)?.display_name ?? '—'
  const overallPct   = Math.round((sub.score_pct as number | null) ?? 0)
  const corePct      = Math.round((sub.core_score_pct as number | null) ?? 0)
  const redFlagCount = (sub.red_flag_count as number | null) ?? 0
  const auditStatus  = (sub.audit_status as string | null) ?? ''
  const date         = sub.submitted_at
    ? new Date(sub.submitted_at as string).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    : '—'

  let pdfBuf: Buffer
  try {
    pdfBuf = await generateAuditPdf({
      submissionId,
      locationName,
      auditorName,
      date,
      overallPct,
      corePct,
      redFlagCount,
      auditStatus,
      topActions: (topActionRows ?? []).map(a => ({
        sort_order: a.sort_order as number,
        action:     a.action as string,
        owner:      a.owner as string | null,
        deadline:   a.deadline as string | null,
      })),
      finalDoneWell:        (sub.final_done_well as string | null) ?? null,
      finalFocusNext:       (sub.final_focus_next as string | null) ?? null,
      finalOverallComments: (sub.final_overall_comments as string | null) ?? null,
      generatedAt:          new Date().toISOString(),
    })
  } catch (err) {
    return { ok: false, error: `PDF error: ${err instanceof Error ? err.message : String(err)}` }
  }

  const resend = getResend()
  if (!resend) return { ok: false, error: 'RESEND_API_KEY not configured' }

  const subject  = `Audit — ${locationName} — ${date}`
  const filename = `Audit-${locationName.replace(/[^a-zA-Z0-9]+/g, '-')}-${date.replace(/\s+/g, '-')}.pdf`

  try {
    const { data, error } = await resend.emails.send({
      from:    getFrom(),
      to:      [email],
      subject,
      text:    `Audit report attached: ${locationName} · ${date}\n\nAuditor: ${auditorName}\nOverall: ${overallPct}%  Core: ${corePct}%  Red Flags: ${redFlagCount}  Status: ${auditStatus}\n\nSent by Killer Kockpit · Killer Kebab internal use only`,
      html:    `<p><strong>Audit report attached</strong><br>${locationName} &middot; ${date}</p><p>Auditor: ${auditorName}<br>Overall: ${overallPct}%&emsp;Core: ${corePct}%&emsp;Red Flags: ${redFlagCount}&emsp;Status: ${auditStatus}</p><p style="color:#6b6760;font-size:12px;">Sent by <strong style="color:#AD3919">Killer Kockpit</strong> &middot; Killer Kebab internal use only</p>`,
      attachments: [{ filename, content: pdfBuf }],
    })
    if (error) return { ok: false, error: `Resend error: ${error.message}` }
    return { ok: true, resendId: data!.id }
  } catch (err) {
    return { ok: false, error: `Send failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function sendDiner(
  submissionId: string,
  email:        string,
): Promise<{ ok: true; resendId: string } | { ok: false; error: string }> {
  const input = await loadDinerPdfData(submissionId)
  if (!input) return { ok: false, error: 'Mystery Diner submission not found or not submitted' }

  let pdfBuf: Buffer
  try {
    pdfBuf = await generateDinerPdf(input, new Date().toISOString())
  } catch (err) {
    return { ok: false, error: `PDF error: ${err instanceof Error ? err.message : String(err)}` }
  }

  const date = new Date(input.submittedAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
  const filename = buildDinerPdfFilename(input.locationName, input.submittedAt)
  const subject  = `Mystery Diner — ${input.locationName} — ${date}`
  const scoreStr = input.scorePct !== null ? `${Math.round(input.scorePct)}%` : '—'

  const resend = getResend()
  if (!resend) return { ok: false, error: 'RESEND_API_KEY not configured' }

  try {
    const { data, error } = await resend.emails.send({
      from:    getFrom(),
      to:      [email],
      subject,
      text:    `Mystery Diner report attached: ${input.locationName} · ${date}\n\nDiner: ${input.dinerName}\nScore: ${scoreStr}  Status: ${input.finalStatus ?? '—'}  Critical failures: ${input.criticalFailCount}  Gold Stars: ${input.goldStarCount}\n\nSent by Killer Kockpit · Killer Kebab internal use only`,
      html:    `<p><strong>Mystery Diner report attached</strong><br>${input.locationName} &middot; ${date}</p><p>Diner: ${input.dinerName}<br>Score: ${scoreStr}&emsp;Status: ${input.finalStatus ?? '—'}&emsp;Critical failures: ${input.criticalFailCount}&emsp;Gold Stars: ${input.goldStarCount}</p><p style="color:#6b6760;font-size:12px;">Sent by <strong style="color:#AD3919">Killer Kockpit</strong> &middot; Killer Kebab internal use only</p>`,
      attachments: [{ filename, content: pdfBuf }],
    })
    if (error) return { ok: false, error: `Resend error: ${error.message}` }
    return { ok: true, resendId: data!.id }
  } catch (err) {
    return { ok: false, error: `Send failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function sendSspCph(
  submissionId: string,
  email:        string,
): Promise<{ ok: true; resendId: string } | { ok: false; error: string }> {
  let sspData: Awaited<ReturnType<typeof fetchSSPCphDataDirect>>
  try {
    sspData = await fetchSSPCphDataDirect()
  } catch (err) {
    return { ok: false, error: `Failed to load SSP/CPH data: ${err instanceof Error ? err.message : String(err)}` }
  }

  const detail = buildSubmissionDetail(sspData, submissionId)
  if (!detail) return { ok: false, error: 'SSP/CPH submission not found' }

  const locationLabel = 'SSP / CPH Airport'
  const generatedAt   = new Date().toISOString()

  let pdfBuf: Buffer
  try {
    pdfBuf = await generateKKCPdf(detail, locationLabel, generatedAt)
  } catch (err) {
    return { ok: false, error: `PDF error: ${err instanceof Error ? err.message : String(err)}` }
  }

  const safeLoc  = locationLabel.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')
  const safeDate = detail.date.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '')
  const filename = `KQC_${safeLoc}_${safeDate}.pdf`
  const subject  = `Killer Kuality Check — ${locationLabel} — ${detail.date}`

  const resend = getResend()
  if (!resend) return { ok: false, error: 'RESEND_API_KEY not configured' }

  try {
    const { data, error } = await resend.emails.send({
      from:    getFrom(),
      to:      [email],
      subject,
      text:    `KQC SSP/CPH report attached: ${detail.date}\n\nOverall: ${detail.overallScore}%  Critical: ${detail.criticalScore}%  Critical failures: ${detail.criticalFailures}\n\nSent by Killer Kockpit · Killer Kebab internal use only`,
      html:    `<p><strong>KQC SSP/CPH report attached</strong><br>${locationLabel} &middot; ${detail.date}</p><p>Overall: ${detail.overallScore}%&emsp;Critical: ${detail.criticalScore}%&emsp;Critical failures: ${detail.criticalFailures}</p><p style="color:#6b6760;font-size:12px;">Sent by <strong style="color:#AD3919">Killer Kockpit</strong> &middot; Killer Kebab internal use only</p>`,
      attachments: [{ filename, content: pdfBuf }],
    })
    if (error) return { ok: false, error: `Resend error: ${error.message}` }
    return { ok: true, resendId: data!.id }
  } catch (err) {
    return { ok: false, error: `Send failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Auth
  const user = await getCurrentUser()
  if (!user) return json({ ok: false, error: 'Not authenticated' }, 401)
  if (!canAccessQualityCheck(user.role)) return json({ ok: false, error: 'Forbidden' }, 403)

  let body: { system?: unknown; submissionId?: unknown; email?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400)
  }

  const { system, submissionId, email } = body

  if (system !== 'audit' && system !== 'ssp_cph' && system !== 'diner') {
    return json({ ok: false, error: 'system must be audit, ssp_cph, or diner' }, 400)
  }
  if (typeof submissionId !== 'string' || !submissionId) {
    return json({ ok: false, error: 'submissionId is required' }, 400)
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return json({ ok: false, error: 'A valid email address is required' }, 400)
  }

  const db = createServiceClient()

  let result: { ok: true; resendId: string } | { ok: false; error: string }

  if (system === 'audit') {
    result = await sendAudit(submissionId, email, db)
  } else if (system === 'diner') {
    result = await sendDiner(submissionId, email)
  } else {
    result = await sendSspCph(submissionId, email)
  }

  // Log — never throws, never blocks response
  await logDelivery(db, `manual_${system}`, submissionId, email, user.id, result)

  if (!result.ok) {
    console.error(`[send-single] ${system} → ${email}: ${result.error}`)
    return json({ ok: false, error: result.error }, 500)
  }

  return json({ ok: true })
}
