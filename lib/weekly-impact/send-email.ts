import 'server-only'
import { Resend } from 'resend'

export interface WeeklyImpactEmailPayload {
  recipient: string
  subject: string
  html: string
  text: string
}

export type WeeklyImpactEmailResult = { ok: true; id: string } | { ok: false; error: string; uncertain: boolean }

export async function sendWeeklyImpactEmail(input: WeeklyImpactEmailPayload, idempotencyKey: string): Promise<WeeklyImpactEmailResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const from = 'Killer Kockpit <notifications@kockpit.killerkebab.com>'
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY is not configured.', uncertain: false }

  try {
    const { data, error } = await new Resend(apiKey).emails.send({
      from,
      to: [input.recipient],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }, { idempotencyKey })
    if (error || !data?.id) return {
      ok: false, error: error?.message ?? 'Resend returned no message id.',
      uncertain: !error?.statusCode || error.statusCode >= 500 || error.statusCode === 409,
    }
    return { ok: true, id: data.id }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Email send failed.', uncertain: true }
  }
}
