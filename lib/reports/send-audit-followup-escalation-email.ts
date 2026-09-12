/**
 * lib/reports/send-audit-followup-escalation-email.ts
 *
 * Sends a Red Flag follow-up escalation email via Resend.
 * Called by runAuditFollowupEscalationJob for each overdue follow-up.
 *
 * Server-only — never import from client components.
 *
 * Required env vars:
 *   RESEND_API_KEY      — Resend API key
 *   RESEND_FROM         — Verified sender, e.g. "Killer Kockpit <notifications@kockpit.killerkebab.com>"
 *   NEXT_PUBLIC_APP_URL — App base URL, e.g. "https://kockpit.killerkebab.com"
 */

import { Resend } from 'resend'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EscalationRedFlagItem {
  title:   string
  section: string
  result:  'pass' | 'fail' | null
}

export interface AuditFollowupEscalationEmailInput {
  submissionId:  string
  locationName:  string
  /** Formatted audit date, e.g. "10 Sep 2026" */
  auditDateStr:  string
  /** ISO timestamptz — when the follow-up was due */
  followupDueAt: string
  redFlagItems:  EscalationRedFlagItem[]
  recipientEmail: string
  recipientName:  string
}

export type EscalationEmailResult =
  | { ok: true;  id: string }
  | { ok: false; error: string }

// ─── Config ───────────────────────────────────────────────────────────────────

function getResendConfig(): { apiKey: string; from: string } | { missing: string[] } {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const from   = process.env.RESEND_FROM?.trim()
  const missing: string[] = []
  if (!apiKey) missing.push('RESEND_API_KEY')
  if (!from)   missing.push('RESEND_FROM')
  if (missing.length) return { missing }
  return { apiKey: apiKey!, from: from! }
}

function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() ?? 'https://kockpit.killerkebab.com'
}

// ─── Styling ──────────────────────────────────────────────────────────────────

const RED    = '#AD3919'
const YELLOW = '#F5DA93'
const INK    = '#171717'
const MUTED  = '#6b6760'
const BAD    = '#8d3737'
const BORDER = '#d9d4cc'
const SOFT   = '#f5f3ee'
const WHITE  = '#ffffff'
const PASS   = '#2d6a4f'
const PASSBG = '#e8f5e9'
const FAILBG = '#fdecea'

// ─── Subject and copy ─────────────────────────────────────────────────────────

export function buildEscalationSubject(locationName: string): string {
  return `Overdue Red Flag Follow-Up — ${locationName}`
}

export function formatFollowupDueDate(dueAt: string): string {
  return new Date(dueAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

export function buildOverdueDays(dueAt: string): string {
  const diffMs   = Date.now() - new Date(dueAt).getTime()
  const diffDays = Math.floor(diffMs / 86_400_000)
  if (diffDays <= 0) return 'overdue today'
  if (diffDays === 1) return '1 day overdue'
  return `${diffDays} days overdue`
}

// ─── Plain text ───────────────────────────────────────────────────────────────

function buildPlainBody(input: AuditFollowupEscalationEmailInput, auditUrl: string): string {
  const { locationName, auditDateStr, followupDueAt, redFlagItems, recipientName } = input
  const dueDateStr  = formatFollowupDueDate(followupDueAt)
  const overdueCopy = buildOverdueDays(followupDueAt)

  const lines: string[] = [
    `Overdue Red Flag Follow-Up — ${locationName}`,
    '',
    `Hi ${recipientName},`,
    '',
    `A Red Flag follow-up for ${locationName} is ${overdueCopy}.`,
    '',
    `Location:     ${locationName}`,
    `Audit date:   ${auditDateStr}`,
    `Follow-up due: ${dueDateStr}`,
    `Red flags:    ${redFlagItems.length}`,
    '',
    'Red Flag checkpoints:',
  ]

  for (const item of redFlagItems) {
    const status = item.result === 'pass' ? '[PASS]' : item.result === 'fail' ? '[FAIL]' : '[PENDING]'
    lines.push(`  ${status} ${item.section} — ${item.title}`)
  }

  lines.push('', `View audit: ${auditUrl}`, '', '—', 'Killer Kockpit · Killer Kebab internal use only')

  return lines.join('\n')
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function buildHtmlBody(input: AuditFollowupEscalationEmailInput, auditUrl: string): string {
  const { locationName, auditDateStr, followupDueAt, redFlagItems, recipientName } = input
  const dueDateStr  = formatFollowupDueDate(followupDueAt)
  const overdueCopy = buildOverdueDays(followupDueAt)
  const rfCount     = redFlagItems.length

  const itemRows = redFlagItems.map(item => {
    const isPass   = item.result === 'pass'
    const isFail   = item.result === 'fail'
    const badge    = isPass
      ? `<span style="display:inline-block;background:${PASSBG};color:${PASS};font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;text-transform:uppercase">Pass</span>`
      : isFail
        ? `<span style="display:inline-block;background:${FAILBG};color:${BAD};font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;text-transform:uppercase">Fail</span>`
        : `<span style="display:inline-block;background:#f5f3ee;color:${MUTED};font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;text-transform:uppercase">Pending</span>`

    return `
      <tr style="border-bottom:1px solid ${BORDER}">
        <td style="padding:8px 0">
          <p style="margin:0 0 2px;font-size:11px;color:${MUTED}">${item.section}</p>
          <p style="margin:0;font-size:13px;color:${INK};font-weight:500">${item.title}</p>
        </td>
        <td style="padding:8px 0 8px 12px;vertical-align:middle;white-space:nowrap">${badge}</td>
      </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Overdue Red Flag Follow-Up</title>
</head>
<body style="margin:0;padding:0;background:${SOFT};font-family:Helvetica,Arial,sans-serif;color:${INK}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};padding:24px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0"
        style="background:${WHITE};border-radius:8px;border:1px solid ${BORDER};overflow:hidden;max-width:560px">

        <!-- Header -->
        <tr>
          <td style="background:${RED};padding:20px 28px">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${YELLOW}">KILLER KOCKPIT</p>
            <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff">Overdue Red Flag Follow-Up</p>
          </td>
        </tr>

        <!-- Alert banner -->
        <tr>
          <td style="padding:16px 28px 0">
            <div style="background:#f5e7e7;border:1px solid #d98080;border-radius:6px;padding:12px 16px">
              <p style="margin:0;font-size:13px;font-weight:600;color:${BAD}">Hi ${recipientName} — a Red Flag follow-up for <strong>${locationName}</strong> is ${overdueCopy}.</p>
            </div>
          </td>
        </tr>

        <!-- Meta row -->
        <tr>
          <td style="padding:20px 28px 0">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:16px">
                  <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Location</p>
                  <p style="margin:0;font-size:14px;font-weight:600;color:${INK}">${locationName}</p>
                </td>
                <td style="padding-right:16px">
                  <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Audit date</p>
                  <p style="margin:0;font-size:14px;font-weight:600;color:${INK}">${auditDateStr}</p>
                </td>
                <td>
                  <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Follow-up due</p>
                  <p style="margin:0;font-size:14px;font-weight:600;color:${BAD}">${dueDateStr}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Red Flag checkpoints -->
        <tr>
          <td style="padding:20px 28px 0">
            <p style="margin:0 0 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">${rfCount} Red Flag${rfCount === 1 ? '' : 's'}</p>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${itemRows}
            </table>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style="padding:20px 28px 24px">
            <a href="${auditUrl}"
               style="display:inline-block;background:${INK};color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;padding:10px 20px;border-radius:8px">
              View audit in Killer Kockpit →
            </a>
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

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Sends a Red Flag follow-up escalation email via Resend.
 * Returns { ok: true, id } on success or { ok: false, error } on failure.
 * Never throws.
 */
export async function sendAuditFollowupEscalationEmail(
  input: AuditFollowupEscalationEmailInput,
): Promise<EscalationEmailResult> {
  const config = getResendConfig()
  if ('missing' in config) {
    return { ok: false, error: `Missing env vars: ${config.missing.join(', ')}` }
  }

  const auditUrl = `${getAppUrl()}/kkc/audit/${input.submissionId}`
  const subject  = buildEscalationSubject(input.locationName)

  const resend = new Resend(config.apiKey)
  try {
    const { data, error } = await resend.emails.send({
      from:    config.from,
      to:      [input.recipientEmail],
      subject,
      text:    buildPlainBody(input, auditUrl),
      html:    buildHtmlBody(input, auditUrl),
    })

    if (error) return { ok: false, error: `Resend API error: ${error.message}` }
    return { ok: true, id: data!.id }
  } catch (err) {
    return { ok: false, error: `Resend request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
