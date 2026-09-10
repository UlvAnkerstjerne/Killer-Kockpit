/**
 * lib/reports/send-email.ts
 *
 * KQC report email service using Resend.
 * Server-only — never import from client components.
 *
 * Required env vars (add to .env.local and Railway):
 *   RESEND_API_KEY   — Resend API key (re_...)
 *   RESEND_FROM      — Verified sender address, e.g. "Killer Kockpit <kockpit@killerkebab.com>"
 *                      The domain (killerkebab.com) must be verified in Resend.
 *
 * Usage:
 *   const result = await sendKKCReportEmail({
 *     detail,
 *     recipientEmail: 'manager@killerkebab.com',
 *     locationLabel:  'SSP / CPH Airport',
 *   })
 *   if (result.error) console.error(result.error)
 *   else console.log('sent, id:', result.id)
 */

import { Resend } from 'resend'
import { generateKKCPdf } from './generate-pdf'
import type { KKCSubmissionDetail } from '@/lib/kkc/ssp-cph'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SendKKCEmailInput {
  detail:         KKCSubmissionDetail
  recipientEmail: string
  locationLabel:  string
  /** ISO timestamp for the "Generated" footer. Defaults to now. */
  generatedAt?:   string
}

export type SendKKCEmailResult =
  | { ok: true;  id: string }
  | { ok: false; error: string }

// ─── Config validation ────────────────────────────────────────────────────────

function getResendConfig(): { apiKey: string; from: string } | { missing: string[] } {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const from   = process.env.RESEND_FROM?.trim()
  const missing: string[] = []
  if (!apiKey) missing.push('RESEND_API_KEY')
  if (!from)   missing.push('RESEND_FROM')
  if (missing.length) return { missing }
  return { apiKey: apiKey!, from: from! }
}

// ─── Subject builder ─────────────────────────────────────────────────────────

function buildSubject(locationLabel: string, date: string): string {
  // "Killer Kuality Check — CPH Airport — 10 Sep 2026"
  return `Killer Kuality Check — ${locationLabel} — ${date}`
}

// ─── PDF filename ─────────────────────────────────────────────────────────────

function buildFilename(locationLabel: string, date: string): string {
  // "KQC_CPH-Airport_10-Sep-2026.pdf"
  const safeLoc  = locationLabel.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')
  const safeDate = date.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '')
  return `KQC_${safeLoc}_${safeDate}.pdf`
}

// ─── Score summary for email body ─────────────────────────────────────────────

function buildPlainBody(detail: KKCSubmissionDetail, locationLabel: string): string {
  const lines: string[] = [
    `Killer Kuality Check — ${locationLabel}`,
    `Date: ${detail.date}  Time: ${detail.time}`,
    `Checker: ${detail.mysteryDiner || '—'}`,
    `Products: ${detail.productsOrdered || '—'}`,
    '',
    `Overall score:   ${detail.overallScore}%`,
    `Critical score:  ${detail.criticalScore}%`,
    `Critical failures: ${detail.criticalFailures}`,
  ]

  if (detail.criticalFailureDetails.length) {
    lines.push('', 'Critical failures:')
    for (const f of detail.criticalFailureDetails) {
      lines.push(`  • ${f.section} — ${f.checkpoint}`)
    }
  }

  lines.push(
    '',
    'Full report attached as PDF.',
    '',
    '—',
    'Killer Kockpit · Killer Kebab internal use only',
  )

  return lines.join('\n')
}

function buildHtmlBody(detail: KKCSubmissionDetail, locationLabel: string): string {
  const RED    = '#AD3919'
  const YELLOW = '#F5DA93'
  const INK    = '#171717'
  const MUTED  = '#6b6760'
  const GOOD   = '#2f6d4c'
  const BAD    = '#8d3737'
  const BORDER = '#d9d4cc'
  const SOFT   = '#f5f3ee'
  const WHITE  = '#ffffff'

  const scoreColor = (pct: number) =>
    pct >= 90 ? GOOD : pct >= 75 ? '#8a5b16' : BAD

  const critItems = detail.criticalFailureDetails.map(f =>
    `<li style="margin:2px 0;color:${BAD}">
       <strong>${f.section}</strong> — ${f.checkpoint}
     </li>`
  ).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${SOFT};font-family:Helvetica,Arial,sans-serif;color:${INK}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};padding:24px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:${WHITE};border-radius:8px;border:1px solid ${BORDER};overflow:hidden;max-width:560px">

        <!-- Header -->
        <tr>
          <td style="background:${RED};padding:20px 28px">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${YELLOW}">KILLER KEBAB</p>
            <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff">Killer Kuality Check</p>
            <p style="margin:4px 0 0;font-size:13px;color:#f0cfc4">${locationLabel}</p>
          </td>
        </tr>

        <!-- Meta -->
        <tr>
          <td style="padding:20px 28px 0">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:16px">
                  <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Date &amp; Time</p>
                  <p style="margin:0;font-size:14px;font-weight:700">${detail.date} · ${detail.time}</p>
                </td>
                <td style="padding-right:16px">
                  <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Checker</p>
                  <p style="margin:0;font-size:14px;font-weight:700">${detail.mysteryDiner || '—'}</p>
                </td>
                <td>
                  <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Products</p>
                  <p style="margin:0;font-size:14px;font-weight:700">${detail.productsOrdered || '—'}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Scores -->
        <tr>
          <td style="padding:16px 28px">
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER};border-radius:6px;overflow:hidden">
              <tr>
                <td style="padding:14px 16px;text-align:center;border-right:1px solid ${BORDER}">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Overall</p>
                  <p style="margin:0;font-size:26px;font-weight:700;color:${scoreColor(detail.overallScore)}">${detail.overallScore}%</p>
                </td>
                <td style="padding:14px 16px;text-align:center;border-right:1px solid ${BORDER}">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Critical</p>
                  <p style="margin:0;font-size:26px;font-weight:700;color:${scoreColor(detail.criticalScore)}">${detail.criticalScore}%</p>
                </td>
                <td style="padding:14px 16px;text-align:center">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Crit Failures</p>
                  <p style="margin:0;font-size:26px;font-weight:700;color:${detail.criticalFailures > 0 ? BAD : GOOD}">${detail.criticalFailures}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        ${detail.criticalFailureDetails.length ? `
        <!-- Critical failures -->
        <tr>
          <td style="padding:0 28px 16px">
            <div style="background:#f5e7e7;border:1px solid #d98080;border-radius:6px;padding:12px 16px">
              <p style="margin:0 0 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${BAD}">⚠ Critical Failures (${detail.criticalFailureDetails.length})</p>
              <ul style="margin:0;padding-left:16px">${critItems}</ul>
            </div>
          </td>
        </tr>` : ''}

        <!-- Attachment note -->
        <tr>
          <td style="padding:0 28px 20px">
            <p style="margin:0;font-size:13px;color:${MUTED}">Full section-by-section breakdown attached as PDF.</p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:${SOFT};border-top:1px solid ${BORDER};padding:12px 28px">
            <p style="margin:0;font-size:11px;color:${MUTED}">
              Sent by <strong style="color:${RED}">Killer Kockpit</strong> · Killer Kebab internal use only
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

// ─── Main service function ────────────────────────────────────────────────────

/**
 * Generates the KQC PDF and sends it to a recipient via Resend.
 *
 * Returns { ok: true, id } on success or { ok: false, error } on failure.
 * Never throws — all errors are captured in the return value.
 *
 * Env vars required:
 *   RESEND_API_KEY  — Resend API key
 *   RESEND_FROM     — Verified sender, e.g. "Killer Kockpit <kockpit@killerkebab.com>"
 */
export async function sendKKCReportEmail(
  input: SendKKCEmailInput,
): Promise<SendKKCEmailResult> {
  const { detail, recipientEmail, locationLabel, generatedAt } = input

  // Validate config
  const config = getResendConfig()
  if ('missing' in config) {
    return {
      ok:    false,
      error: `Missing env vars: ${config.missing.join(', ')}. See lib/reports/send-email.ts for setup instructions.`,
    }
  }

  // Generate PDF
  let pdfBuf: Buffer
  try {
    pdfBuf = await generateKKCPdf(detail, locationLabel, generatedAt ?? new Date().toISOString())
  } catch (err) {
    return {
      ok:    false,
      error: `PDF generation failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const subject  = buildSubject(locationLabel, detail.date)
  const filename = buildFilename(locationLabel, detail.date)

  // Send via Resend
  const resend = new Resend(config.apiKey)
  try {
    const { data, error } = await resend.emails.send({
      from:    config.from,
      to:      [recipientEmail],
      subject,
      text:    buildPlainBody(detail, locationLabel),
      html:    buildHtmlBody(detail, locationLabel),
      attachments: [
        {
          filename,
          content: pdfBuf,
        },
      ],
    })

    if (error) {
      return { ok: false, error: `Resend API error: ${error.message}` }
    }

    return { ok: true, id: data!.id }
  } catch (err) {
    return {
      ok:    false,
      error: `Resend request failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
