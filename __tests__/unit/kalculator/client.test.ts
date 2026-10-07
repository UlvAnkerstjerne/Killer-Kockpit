import { describe, expect, it, vi } from 'vitest'
import { addDays, cphDate, kalculatorPeriodRange } from '@/lib/kalculator/periods'
import {
  KALCULATOR_STORE_SLUGS,
  fetchStoreSummary,
  getKalculatorConfig,
  isKalculatorStoreSlug,
  loadStorePerformance,
  type KalculatorConfig,
} from '@/lib/kalculator/client'

const TOKEN = 't'.repeat(48)
const config: KalculatorConfig = { baseUrl: 'https://kalculator.example', token: TOKEN }

function summary(slug: string, start: string, end: string, metrics: Record<string, unknown> = {}) {
  return {
    storeId: slug, start, end, complete: true, source: 'hybrid',
    metrics: {
      revenueExVat: 18420.5, salaryCost: 4560, salaryPct: 24.76,
      rollUnits: 103, komboUnits: 71, komboPct: 40.8, lemonadeUnits: 46, ...metrics,
    },
  }
}

/** Fake Kalculator that echoes the requested range back. */
function fakeKalculator(override?: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (override) return override(url)
    const [, , , , slug, start, end] = new URL(url).pathname.split('/')
    return Response.json(summary(slug, start, end))
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

// ── Periods ──────────────────────────────────────────────────────────────────
describe('Kalculator period boundaries (Europe/Copenhagen, [start, end))', () => {
  // Wednesday 2026-10-07 10:00 CPH
  const wed = new Date('2026-10-07T08:00:00Z')

  it('today / yesterday', () => {
    expect(kalculatorPeriodRange('today', wed)).toEqual({ start: '2026-10-07', end: '2026-10-08' })
    expect(kalculatorPeriodRange('yesterday', wed)).toEqual({ start: '2026-10-06', end: '2026-10-07' })
  })
  it('week starts Monday and ends after today', () => {
    expect(kalculatorPeriodRange('week', wed)).toEqual({ start: '2026-10-05', end: '2026-10-08' })
    const sunday = new Date('2026-10-11T20:00:00Z') // 22:00 CPH Sunday
    expect(kalculatorPeriodRange('week', sunday)).toEqual({ start: '2026-10-05', end: '2026-10-12' })
    const monday = new Date('2026-10-12T05:00:00Z')
    expect(kalculatorPeriodRange('week', monday)).toEqual({ start: '2026-10-12', end: '2026-10-13' })
  })
  it('month starts on the 1st and ends after today', () => {
    expect(kalculatorPeriodRange('month', wed)).toEqual({ start: '2026-10-01', end: '2026-10-08' })
    const lastDay = new Date('2026-10-31T21:00:00Z') // 22:00 CPH (after DST end)
    expect(kalculatorPeriodRange('month', lastDay)).toEqual({ start: '2026-10-01', end: '2026-11-01' })
  })
  it('uses the Copenhagen day, not UTC', () => {
    // 23:30 UTC on Oct 6 is already Oct 7 in Copenhagen
    expect(cphDate(new Date('2026-10-06T23:30:00Z'))).toBe('2026-10-07')
    expect(kalculatorPeriodRange('today', new Date('2026-10-06T23:30:00Z')).start).toBe('2026-10-07')
  })
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(kalculatorPeriodRange('week', new Date('2027-01-01T10:00:00Z')).start).toBe('2026-12-28')
  })
})

// ── Store mapping ────────────────────────────────────────────────────────────
describe('Kalculator store slugs', () => {
  it('accepts exactly the six Kalculator stores', () => {
    expect([...KALCULATOR_STORE_SLUGS].sort()).toEqual(
      ['christianshavn', 'fisketorvet', 'frederiksberg', 'indre-by', 'norrebro', 'vesterbro'])
    for (const bad of ['airport', 'parken', 'nørrebro', 'Indre By', '', null, undefined, '../x']) {
      expect(isKalculatorStoreSlug(bad)).toBe(false)
    }
  })
  it('unsupported / unmapped location makes no request and is fully unavailable', async () => {
    const fetchImpl = fakeKalculator()
    for (const slug of [null, 'airport', 'parken', 'indre-by/../../etc']) {
      const perf = await loadStorePerformance(slug, { config, fetchImpl })
      for (const p of Object.values(perf)) {
        expect(p).toEqual({ revenueExVat: null, salaryPct: null, komboPct: null, lemonadeUnits: null })
      }
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// ── Config ───────────────────────────────────────────────────────────────────
describe('Kalculator config', () => {
  it('requires URL and a long token; https only except localhost', () => {
    expect(getKalculatorConfig({})).toBeNull()
    expect(getKalculatorConfig({ KALCULATOR_API_URL: 'https://k.example' })).toBeNull()
    expect(getKalculatorConfig({ KALCULATOR_API_URL: 'https://k.example', KALCULATOR_READ_TOKEN: 'short' })).toBeNull()
    expect(getKalculatorConfig({ KALCULATOR_API_URL: 'http://k.example', KALCULATOR_READ_TOKEN: TOKEN })).toBeNull()
    expect(getKalculatorConfig({ KALCULATOR_API_URL: 'not a url', KALCULATOR_READ_TOKEN: TOKEN })).toBeNull()
    expect(getKalculatorConfig({ KALCULATOR_API_URL: 'https://k.example/x/', KALCULATOR_READ_TOKEN: TOKEN }))
      .toEqual({ baseUrl: 'https://k.example', token: TOKEN })
    expect(getKalculatorConfig({ KALCULATOR_API_URL: 'http://localhost:3000', KALCULATOR_READ_TOKEN: TOKEN }))
      .toEqual({ baseUrl: 'http://localhost:3000', token: TOKEN })
  })
  it('unconfigured integration returns unavailable without calling out', async () => {
    const fetchImpl = fakeKalculator()
    const perf = await loadStorePerformance('indre-by', { config: null, fetchImpl })
    expect(perf.today.revenueExVat).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// ── Requests and validation ─────────────────────────────────────────────────
describe('Kalculator summary client', () => {
  const now = new Date('2026-10-07T08:00:00Z')

  it('one request per period, server-side bearer auth, exact path', async () => {
    const fetchImpl = fakeKalculator()
    const perf = await loadStorePerformance('indre-by', { config, fetchImpl, now })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    const urls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0])).sort()
    expect(urls).toEqual([
      'https://kalculator.example/api/internal/store-summary/indre-by/2026-10-01/2026-10-08',
      'https://kalculator.example/api/internal/store-summary/indre-by/2026-10-05/2026-10-08',
      'https://kalculator.example/api/internal/store-summary/indre-by/2026-10-06/2026-10-07',
      'https://kalculator.example/api/internal/store-summary/indre-by/2026-10-07/2026-10-08',
    ])
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(init.cache).toBe('no-store')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(perf.today).toEqual({ revenueExVat: 18420.5, salaryPct: 24.76, komboPct: 40.8, lemonadeUnits: 46 })
  })

  it('keeps genuine zeros distinct from unavailable', async () => {
    const fetchImpl = fakeKalculator(url => {
      const [, , , , slug, start, end] = new URL(url).pathname.split('/')
      return Response.json(summary(slug, start, end, { komboPct: 0, komboUnits: 0, lemonadeUnits: 0, salaryCost: null, salaryPct: null }))
    })
    const perf = await loadStorePerformance('vesterbro', { config, fetchImpl, now })
    expect(perf.week.komboPct).toBe(0)
    expect(perf.week.lemonadeUnits).toBe(0)
    expect(perf.week.salaryPct).toBeNull()
  })

  it.each([
    ['HTTP 503', () => Response.json({ complete: false, metrics: null }, { status: 503 })],
    ['HTTP 401', () => Response.json({ error: 'Unauthorized' }, { status: 401 })],
    ['network error', () => { throw new TypeError('fetch failed') }],
    ['non-JSON body', () => new Response('<html>', { status: 200 })],
    ['missing metrics', () => Response.json({ storeId: 'indre-by', start: '2026-10-07', end: '2026-10-08', complete: true, source: 'database' })],
    ['complete false', () => Response.json({ ...summary('indre-by', '2026-10-07', '2026-10-08'), complete: false })],
    ['string revenue', () => Response.json(summary('indre-by', '2026-10-07', '2026-10-08', { revenueExVat: '18420' }))],
    ['different store echoed', () => Response.json(summary('vesterbro', '2026-10-07', '2026-10-08'))],
    ['different range echoed', () => Response.json(summary('indre-by', '2026-10-01', '2026-10-08'))],
  ])('fails safe on %s', async (_label, respond) => {
    const fetchImpl = fakeKalculator(respond as () => Response)
    const result = await fetchStoreSummary('indre-by', { start: '2026-10-07', end: '2026-10-08' }, { config, fetchImpl })
    expect(result).toBeNull()
  })

  it('times out quickly and returns unavailable', async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })) as unknown as typeof fetch
    const started = Date.now()
    const perf = await loadStorePerformance('indre-by', { config, fetchImpl, now, timeoutMs: 50 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(perf.month).toEqual({ revenueExVat: null, salaryPct: null, komboPct: null, lemonadeUnits: null })
  })

  it('one failing period does not blank the others', async () => {
    const fetchImpl = fakeKalculator(url => {
      const [, , , , slug, start, end] = new URL(url).pathname.split('/')
      if (start === '2026-10-07') return new Response('', { status: 502 })
      return Response.json(summary(slug, start, end))
    })
    const perf = await loadStorePerformance('norrebro', { config, fetchImpl, now })
    expect(perf.today.revenueExVat).toBeNull()
    expect(perf.month.revenueExVat).toBe(18420.5)
  })

  it('never logs the integration token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await fetchStoreSummary('indre-by', { start: '2026-10-07', end: '2026-10-08' },
      { config, fetchImpl: fakeKalculator(() => { throw new Error(`boom ${TOKEN}`) }) })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN)
    warn.mockRestore()
  })
})
