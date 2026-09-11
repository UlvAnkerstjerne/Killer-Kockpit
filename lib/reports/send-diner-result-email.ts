/**
 * lib/reports/send-diner-result-email.ts
 *
 * Sends a Mystery Diner result notification email via Resend.
 * No PDF. Clear summary with scores, critical failures by name, and a
 * direct link to the result in Kockpit.
 *
 * Server-only — never import from client components.
 *
 * Required env vars:
 *   RESEND_API_KEY      — Resend API key
 *   RESEND_FROM         — Verified sender, e.g. "Killer Kockpit <kockpit@killerkebab.com>"
 *   NEXT_PUBLIC_APP_URL — App base URL, e.g. "https://kockpit.killerkebab.com"
 */

import { Resend } from 'resend'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DinerResultEmailInput {
  submissionId:       string
  locationName:       string
  dinerName:          string
  date:               string    // pre-formatted, e.g. "10 Sep 2026"
  scorePct:           number | null
  finalStatus:        string | null  // 'GREEN' | 'YELLOW' | 'RED'
  criticalFailCount:  number
  goldStarCount:      number
  waitingTimeBand:    string | null
  /** Checkpoint labels for critical failures — shown in email body */
  criticalFailLabels: string[]
  recipientEmail:     string
}

export type DinerResultEmailResult =
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
const GOOD   = '#2f6d4c'
const BAD    = '#8d3737'
const AMBER  = '#8a5b16'
const BORDER = '#d9d4cc'
const SOFT   = '#f5f3ee'
const WHITE  = '#ffffff'

function statusColor(status: string | null): string {
  switch (status) {
    case 'GREEN':  return GOOD
    case 'YELLOW': return AMBER
    case 'RED':    return BAD
    default:       return MUTED
  }
}

function scoreColor(pct: number | null): string {
  if (pct === null) return MUTED
  if (pct >= 86) return GOOD
  if (pct >= 67) return AMBER
  return BAD
}

// ─── Subject ──────────────────────────────────────────────────────────────────

export function buildDinerResultSubject(locationName: string, status: string | null): string {
  const statusLabel = status ?? '—'
  return `Mystery Diner result — ${locationName} — ${statusLabel}`
}

// ─── Plain text ───────────────────────────────────────────────────────────────

function buildPlainBody(input: DinerResultEmailInput, resultUrl: string): string {
  const { locationName, dinerName, date, scorePct, finalStatus, criticalFailCount,
    goldStarCount, waitingTimeBand, criticalFailLabels } = input

  const lines: string[] = [
    `Mystery Diner result — ${locationName}`,
    `Date: ${date}`,
    `Diner: ${dinerName}`,
    '',
    `Score:            ${scorePct !== null ? `${Math.round(scorePct)}%` : '—'}`,
    `Status:           ${finalStatus ?? '—'}`,
    `Critical failures: ${criticalFailCount}`,
    `Gold Stars:        ${goldStarCount}`,
    waitingTimeBand ? `Waiting time:     ${waitingTimeBand} min` : null,
    '',
  ].filter((l): l is string => l !== null)

  if (criticalFailLabels.length > 0) {
    lines.push('Critical failures:')
    for (const label of criticalFailLabels) {
      lines.push(`  • ${label}`)
    }
    lines.push('')
  }

  lines.push(
    `View result: ${resultUrl}`,
    '',
    '—',
    'Killer Kockpit · Killer Kebab internal use only',
  )

  return lines.join('\n')
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function buildHtmlBody(input: DinerResultEmailInput, resultUrl: string): string {
  const { locationName, dinerName, date, scorePct, finalStatus, criticalFailCount,
    goldStarCount, waitingTimeBand, criticalFailLabels } = input

  const critItems = criticalFailLabels.map(label =>
    `<li style="margin:3px 0;color:${BAD}">${label}</li>`
  ).join('')

  const critBlock = criticalFailLabels.length > 0 ? `
        <!-- Critical failures -->
        <tr>
          <td style="padding:0 28px 20px">
            <div style="background:#f5e7e7;border:1px solid #d98080;border-radius:6px;padding:12px 16px">
              <p style="margin:0 0 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${BAD}">Critical failures (${criticalFailLabels.length})</p>
              <ul style="margin:0;padding-left:16px">${critItems}</ul>
            </div>
          </td>
        </tr>` : ''

  const waitRow = waitingTimeBand ? `
              <td style="padding:14px 16px;text-align:center">
                <p style="margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Wait</p>
                <p style="margin:0;font-size:18px;font-weight:700;color:${INK}">${waitingTimeBand} min</p>
              </td>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Mystery Diner result</title>
</head>
<body style="margin:0;padding:0;background:${SOFT};font-family:Helvetica,Arial,sans-serif;color:${INK}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};padding:24px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0"
        style="background:${WHITE};border-radius:8px;border:1px solid ${BORDER};overflow:hidden;max-width:560px">

        <!-- Header -->
        <tr>
          <td style="background:${RED};padding:20px 28px">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${YELLOW}">KILLER KEBAB</p>
            <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff">Mystery Diner Result</p>
            <p style="margin:4px 0 0;font-size:13px;color:#f0cfc4">${locationName}</p>
          </td>
        </tr>

        <!-- Meta -->
        <tr>
          <td style="padding:20px 28px 0">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:16px">
                  <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Date</p>
                  <p style="margin:0;font-size:14px;font-weight:700">${date}</p>
                </td>
                <td>
                  <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Diner</p>
                  <p style="margin:0;font-size:14px;font-weight:700">${dinerName}</p>
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
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Score</p>
                  <p style="margin:0;font-size:26px;font-weight:700;color:${scoreColor(scorePct)}">
                    ${scorePct !== null ? `${Math.round(scorePct)}%` : '—'}
                  </p>
                </td>
                <td style="padding:14px 16px;text-align:center;border-right:1px solid ${BORDER}">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Status</p>
                  <p style="margin:0;font-size:20px;font-weight:700;color:${statusColor(finalStatus)}">${finalStatus ?? '—'}</p>
                </td>
                <td style="padding:14px 16px;text-align:center;border-right:1px solid ${BORDER}">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Criticals</p>
                  <p style="margin:0;font-size:26px;font-weight:700;color:${criticalFailCount > 0 ? BAD : GOOD}">${criticalFailCount}</p>
                </td>
                <td style="padding:14px 16px;text-align:center;border-right:1px solid ${BORDER}">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Gold Stars</p>
                  <p style="margin:0;font-size:26px;font-weight:700;color:${goldStarCount > 0 ? '#AD6B1D' : INK}">${goldStarCount > 0 ? `★${goldStarCount}` : goldStarCount}</p>
                </td>
                ${waitRow}
              </tr>
            </table>
          </td>
        </tr>

        ${critBlock}

        <!-- CTA -->
        <tr>
          <td style="padding:0 28px 24px">
            <a href="${resultUrl}"
               style="display:inline-block;background:${INK};color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;padding:10px 20px;border-radius:8px">
              View result in Killer Kockpit →
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
 * Sends a Mystery Diner result email via Resend.
 * Returns { ok: true, id } on success or { ok: false, error } on failure.
 * Never throws.
 */
export async function sendDinerResultEmail(
  input: DinerResultEmailInput,
): Promise<DinerResultEmailResult> {
  const config = getResendConfig()
  if ('missing' in config) {
    return { ok: false, error: `Missing env vars: ${config.missing.join(', ')}` }
  }

  const resultUrl = `${getAppUrl()}/kkc/diner/${input.submissionId}`
  const subject   = buildDinerResultSubject(input.locationName, input.finalStatus)

  const resend = new Resend(config.apiKey)
  try {
    const { data, error } = await resend.emails.send({
      from:    config.from,
      to:      [input.recipientEmail],
      subject,
      text:    buildPlainBody(input, resultUrl),
      html:    buildHtmlBody(input, resultUrl),
    })

    if (error) return { ok: false, error: `Resend API error: ${error.message}` }
    return { ok: true, id: data!.id }
  } catch (err) {
    return { ok: false, error: `Resend request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
