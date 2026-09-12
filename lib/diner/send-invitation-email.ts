/**
 * lib/diner/send-invitation-email.ts
 *
 * Sends a Mystery Diner invitation email via Resend.
 *
 * Env vars required:
 *   RESEND_API_KEY — Resend API key
 *   RESEND_FROM    — Verified sender, e.g. "Killer Kockpit <notifications@kockpit.killerkebab.com>"
 *
 * Server-only — never import from client components.
 */

import { Resend } from 'resend'

export interface DinerInvitationEmailInput {
  recipientEmail: string
  dinerName:      string
  locationName:   string | null
  inviteUrl:      string
  expiresAt:      string
}

export type DinerInvitationEmailResult =
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

function fmtExpiry(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  })
}

function buildPlainText(input: DinerInvitationEmailInput): string {
  const { dinerName, locationName, inviteUrl, expiresAt } = input
  const lines = [
    `Hi ${dinerName},`,
    '',
    `You've been invited to complete a Mystery Diner visit for Killer Kebab.`,
    '',
    locationName ? `Store: ${locationName}` : '',
    '',
    'To begin your visit, open the link below:',
    inviteUrl,
    '',
    `This link expires: ${fmtExpiry(expiresAt)}`,
    '',
    'This link is personal. Please do not forward it to others.',
    '',
    '—',
    'Killer Kebab',
  ].filter(l => l !== undefined)

  return lines.join('\n')
}

function buildHtml(input: DinerInvitationEmailInput): string {
  const { dinerName, locationName, inviteUrl, expiresAt } = input

  const RED    = '#AD3919'
  const YELLOW = '#F5DA93'
  const INK    = '#171717'
  const MUTED  = '#6b6760'
  const BORDER = '#d9d4cc'
  const SOFT   = '#f5f3ee'
  const WHITE  = '#ffffff'

  const locationRow = locationName
    ? `<tr>
         <td style="padding:0 28px 16px">
           <table cellpadding="0" cellspacing="0">
             <tr>
               <td>
                 <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Store</p>
                 <p style="margin:0;font-size:14px;font-weight:700;color:${INK}">${locationName}</p>
               </td>
             </tr>
           </table>
         </td>
       </tr>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Mystery Diner invitation</title>
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
              You've been invited to complete a Mystery Diner visit for Killer Kebab.
            </p>
          </td>
        </tr>

        ${locationRow}

        <!-- CTA -->
        <tr>
          <td style="padding:4px 28px 24px">
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:${RED};border-radius:8px">
                  <a href="${inviteUrl}"
                    style="display:inline-block;padding:14px 28px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.2px">
                    Open Mystery Diner →
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Expiry -->
        <tr>
          <td style="padding:0 28px 20px">
            <p style="margin:0;font-size:12px;color:${MUTED}">
              This link expires: <strong style="color:${INK}">${fmtExpiry(expiresAt)}</strong>
            </p>
          </td>
        </tr>

        <!-- Privacy note -->
        <tr>
          <td style="padding:0 28px 8px">
            <p style="margin:0;font-size:11px;color:${MUTED};line-height:1.5">
              This link is personal to you — please do not forward it to others.
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
 * Sends a Mystery Diner invitation email via Resend.
 * Never throws — all errors are returned in the result.
 */
export async function sendDinerInvitationEmail(
  input: DinerInvitationEmailInput,
): Promise<DinerInvitationEmailResult> {
  const config = getResendConfig()
  if ('missing' in config) {
    return { ok: false, error: `Missing env vars: ${config.missing.join(', ')}` }
  }

  const resend = new Resend(config.apiKey)
  try {
    const { data, error } = await resend.emails.send({
      from:    config.from,
      to:      [input.recipientEmail],
      subject: 'Mystery Diner invitation — Killer Kebab',
      text:    buildPlainText(input),
      html:    buildHtml(input),
    })

    if (error) {
      return { ok: false, error: `Resend API error: ${error.message}` }
    }

    return { ok: true, resendId: data!.id }
  } catch (err) {
    return {
      ok:    false,
      error: `Resend request failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
