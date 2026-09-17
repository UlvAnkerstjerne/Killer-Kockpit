import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { send } = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('resend', () => ({ Resend: class { emails = { send } } }))
import { sendWeeklyImpactEmail } from '@/lib/weekly-impact/send-email'
const payload = { recipient: 'ulv@example.com', subject: 'Approved', html: '<p>Approved</p>', text: 'Approved' }
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('RESEND_API_KEY', 'test-key') })
afterEach(() => vi.unstubAllEnvs())
describe('provider delivery', () => {
  it('uses a stable idempotency key and exactly one recipient', async () => {
    send.mockResolvedValue({ data: { id: 'provider-1' }, error: null })
    expect(await sendWeeklyImpactEmail(payload, 'weekly-impact/user/week')).toEqual({ ok: true, id: 'provider-1' })
    expect(send).toHaveBeenCalledWith({ from: 'Killer Kockpit <notifications@kockpit.killerkebab.com>', to: ['ulv@example.com'], subject: payload.subject, html: payload.html, text: payload.text }, { idempotencyKey: 'weekly-impact/user/week' })
  })
  it('distinguishes definite rejection from an uncertain network failure', async () => {
    send.mockResolvedValueOnce({ error: { statusCode: 429, message: 'Rate limited' } }).mockRejectedValueOnce(new Error('Connection lost'))
    expect(await sendWeeklyImpactEmail(payload, 'key')).toMatchObject({ ok: false, uncertain: false })
    expect(await sendWeeklyImpactEmail(payload, 'key')).toMatchObject({ ok: false, uncertain: true })
  })
})
