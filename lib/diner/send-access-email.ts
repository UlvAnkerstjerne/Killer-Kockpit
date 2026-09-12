/**
 * lib/diner/send-access-email.ts
 *
 * Sends a Mystery Diner reusable access email via Resend.
 * Subject: "Your Killer Kebab Mystery Diner access"
 *
 * Unlike the one-time invitation email, there is no expiry — the link is
 * permanent until management disables the diner.
 *
 * Env vars required:
 *   RESEND_API_KEY — Resend API key
 *   RESEND_FROM    — Verified sender, e.g. "Killer Kockpit <notifications@kockpit.killerkebab.com>"
 *
 * Server-only — never import from client components.
 */

import { Resend } from 'resend'

export interface DinerAccessEmailInput {
  recipientEmail: string
  dinerName:      string
  accessUrl:      string
}

export type DinerAccessEmailResult =
  | { ok: true;  resendId: string }
  | { ok: false; error:    string }

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

// ─── Email templates ──────────────────────────────────────────────────────────

function buildPlainText({ dinerName, accessUrl }: DinerAccessEmailInput): string {
  return [
    `Hi ${dinerName},`,
    '',
    'Here is your personal Mystery Diner access link for Killer Kebab.',
    '',
    'Your link:',
    accessUrl,
    '',
    'Use this link to start each of your Mystery Diner visits. You can return to it as many times as needed.',
    '',
    'This link is personal to you — please do not share it with others.',
    '',
    '—',
    'Killer Kebab',
  ].join('\n')
}

function buildHtml({ dinerName, accessUrl }: DinerAccessEmailInput): string {
  const RED    = '#AD3919'
  const YELLOW = '#F5DA93'
  const INK    = '#171717'
  const MUTED  = '#6b6760'
  const BORDER = '#d9d4cc'
  const SOFT   = '#f5f3ee'
  const WHITE  = '#ffffff'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Your Mystery Diner access</title>
</head>
<body style="margin:0;padding:0;background:${SOFT};font-family:Helvetica,Arial,sans-serif;color:${INK}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0"
        style="background:${WHITE};border-radius:8px;border:1px solid ${BORDER};overflow:hidden;max-width:560px">

        <!-- Header -->
        <tr>
          <td style="background:${RED};padding:22px 28px">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${YELLOW}">KILLER KEBAB</p>
            <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff">Mystery Diner</p>
          </td>
        </tr>

        <!-- Greeting -->
        <tr>
          <td style="padding:24px 28px 16px">
            <p style="margin:0 0 12px;font-size:15px;color:${INK}">Hi <strong>${dinerName}</strong>,</p>
            <p style="margin:0;font-size:14px;line-height:1.6;color:${INK}">
              Here is your personal Mystery Diner access link for Killer Kebab. Use it to start each of your visits — it's yours to keep.
            </p>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style="padding:4px 28px 24px">
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:${RED};border-radius:8px">
                  <a href="${accessUrl}"
                    style="display:inline-block;padding:14px 28px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.2px">
                    Open Mystery Diner →
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Privacy note -->
        <tr>
          <td style="padding:0 28px 8px">
            <p style="margin:0;font-size:11px;color:${MUTED};line-height:1.5">
              This link is personal to you — please do not share it with others.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:${SOFT};border-top:1px solid ${BORDER};padding:14px 28px">
            <p style="margin:0;font-size:11px;color:${MUTED}">
              Sent by <strong style="color:${RED}">Killer Kebab</strong>
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
 * Sends a Mystery Diner reusable access email via Resend.
 * Never throws — all errors are returned in the result.
 */
export async function sendDinerAccessEmail(
  input: DinerAccessEmailInput,
): Promise<DinerAccessEmailResult> {
  const config = getResendConfig()
  if ('missing' in config) {
    return { ok: false, error: `Missing env vars: ${config.missing.join(', ')}` }
  }

  const resend = new Resend(config.apiKey)
  try {
    const { data, error } = await resend.emails.send({
      from:    config.from,
      to:      [input.recipientEmail],
      subject: 'Your Killer Kebab Mystery Diner access',
      text:    buildPlainText(input),
      html:    buildHtml(input),
    })

    if (error) return { ok: false, error: `Resend API error: ${error.message}` }
    return { ok: true, resendId: data!.id }
  } catch (err) {
    return {
      ok:    false,
      error: `Resend request failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
