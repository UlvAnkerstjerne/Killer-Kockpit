/**
 * lib/reports/send-audit-email.ts
 *
 * Sends an audit result summary email via Resend.
 * No PDF — plain summary with scores and a direct link to the audit in Kockpit.
 *
 * Server-only — never import from client components.
 *
 * Required env vars:
 *   RESEND_API_KEY   — Resend API key
 *   RESEND_FROM      — Verified sender, e.g. "Killer Kockpit <kockpit@killerkebab.com>"
 *   NEXT_PUBLIC_APP_URL — App base URL, e.g. "https://kockpit.killerkebab.com"
 */

import { Resend } from 'resend'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuditEmailInput {
  submissionId:   string
  locationName:   string
  auditorName:    string
  date:           string  // pre-formatted, e.g. "10 Sep 2026"
  overallPct:     number
  corePct:        number
  redFlagCount:   number
  auditStatus:    string  // e.g. "GREEN", "YELLOW"
  recipientEmail: string
}

export type AuditEmailResult =
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

// ─── Styling helpers ──────────────────────────────────────────────────────────

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

function statusColor(status: string): string {
  switch (status) {
    case 'GREEN':       return GOOD
    case 'LIGHT_GREEN': return '#3a7d5a'
    case 'YELLOW':      return AMBER
    case 'ORANGE':      return '#8a5220'
    case 'RED':         return BAD
    default:            return MUTED
  }
}

function scoreColor(pct: number): string {
  if (pct >= 90) return GOOD
  if (pct >= 75) return AMBER
  return BAD
}

// ─── Email bodies ─────────────────────────────────────────────────────────────

function buildSubject(locationName: string, date: string): string {
  return `Audit — ${locationName} — ${date}`
}

function buildPlainBody(input: AuditEmailInput, auditUrl: string): string {
  const { locationName, auditorName, date, overallPct, corePct, redFlagCount, auditStatus } = input
  return [
    `Audit — ${locationName}`,
    `Date: ${date}`,
    `Auditor: ${auditorName}`,
    '',
    `Overall score:  ${overallPct}%`,
    `Core score:     ${corePct}%`,
    `Red flags:      ${redFlagCount}`,
    `Status:         ${auditStatus}`,
    '',
    `Full audit: ${auditUrl}`,
    '',
    '—',
    'Killer Kockpit · Killer Kebab internal use only',
  ].join('\n')
}

function buildHtmlBody(input: AuditEmailInput, auditUrl: string): string {
  const { locationName, auditorName, date, overallPct, corePct, redFlagCount, auditStatus } = input
  const rfColor = redFlagCount > 0 ? BAD : GOOD

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
            <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff">Audit Result</p>
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
                  <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Auditor</p>
                  <p style="margin:0;font-size:14px;font-weight:700">${auditorName}</p>
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
                  <p style="margin:0;font-size:26px;font-weight:700;color:${scoreColor(overallPct)}">${overallPct}%</p>
                </td>
                <td style="padding:14px 16px;text-align:center;border-right:1px solid ${BORDER}">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Core</p>
                  <p style="margin:0;font-size:26px;font-weight:700;color:${scoreColor(corePct)}">${corePct}%</p>
                </td>
                <td style="padding:14px 16px;text-align:center;border-right:1px solid ${BORDER}">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Red Flags</p>
                  <p style="margin:0;font-size:26px;font-weight:700;color:${rfColor}">${redFlagCount}</p>
                </td>
                <td style="padding:14px 16px;text-align:center">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Status</p>
                  <p style="margin:0;font-size:18px;font-weight:700;color:${statusColor(auditStatus)}">${auditStatus}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Link -->
        <tr>
          <td style="padding:0 28px 24px">
            <a href="${auditUrl}"
               style="display:inline-block;background:${INK};color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;padding:10px 20px;border-radius:8px">
              View full audit →
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
 * Sends an audit result summary email via Resend.
 * Returns { ok: true, id } on success or { ok: false, error } on failure.
 * Never throws.
 */
export async function sendAuditResultEmail(
  input: AuditEmailInput,
): Promise<AuditEmailResult> {
  const config = getResendConfig()
  if ('missing' in config) {
    return { ok: false, error: `Missing env vars: ${config.missing.join(', ')}` }
  }

  const auditUrl = `${getAppUrl()}/kkc/audit/${input.submissionId}`
  const subject  = buildSubject(input.locationName, input.date)

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
