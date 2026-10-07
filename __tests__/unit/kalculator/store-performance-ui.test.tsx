import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/actions/todos', () => ({ reorderTodos: vi.fn() }))
import { StorePerformance } from '@/app/(app)/store/StoreDashboardClient'
import { formatPercent1, formatRevenueCompact, formatUnits, type StorePerformance as Perf } from '@/lib/kalculator/types'

const kitchen = { kitchenPct: 14.2, vsTarget: null }
const render = (performance: Perf) => renderToStaticMarkup(
  <StorePerformance performance={performance}
    kitchenToday={kitchen} kitchenYesterday={kitchen} kitchenWeek={kitchen} kitchenMonth={kitchen} />,
)
const all = (p: Perf['today']): Perf => ({ today: p, yesterday: p, week: p, month: p })
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('SMD display formatting', () => {
  it('null renders as em dash; zero renders as zero', () => {
    expect(formatPercent1(null)).toBe('—')
    expect(formatPercent1(0)).toBe('0.0%')
    expect(formatPercent1(40.8)).toBe('40.8%')
    expect(formatUnits(null)).toBe('—')
    expect(formatUnits(0)).toBe('0')
    expect(formatUnits(46)).toBe('46')
    expect(formatRevenueCompact(null)).toBe('—')
    expect(formatRevenueCompact(0)).toBe('0')
    expect(formatRevenueCompact(18420.5)).toBe('18K')
    expect(formatRevenueCompact(1_234_567)).toBe('1.2M')
  })
})

describe('Store Performance block', () => {
  it('renders live Revenue, Labour, Kombo % and Lemonades sold', () => {
    const t = text(render(all({ revenueExVat: 18420.5, salaryPct: 24.76, komboPct: 40.8, lemonadeUnits: 46 })))
    expect(t).toContain('Revenue 18K')
    expect(t).toContain('Labour 24.8%')
    expect(t).toContain('Kombo % 40.8%')
    expect(t).toContain('Lemonades sold 46')
    expect(t).toContain('Kitchen 14.2%') // unchanged, still unwired
  })
  it('shows — for unavailable values, never demo numbers', () => {
    const html = render(all({ revenueExVat: null, salaryPct: null, komboPct: null, lemonadeUnits: null }))
    const t = text(html)
    expect(t).toContain('Revenue — ')
    expect(t).toContain('Labour — ')
    expect(t).toContain('Kombo % — ')
    expect(t).toContain('Lemonades sold — ')
    for (const demo of ['387K', '98K', '64.2%', '28.4%', 'vs budget', 'vs last']) expect(html).not.toContain(demo)
  })
  it('distinguishes genuine zero from unavailable', () => {
    const t = text(render(all({ revenueExVat: 1520, salaryPct: null, komboPct: 0, lemonadeUnits: 0 })))
    expect(t).toContain('Kombo % 0.0%')
    expect(t).toContain('Lemonades sold 0')
    expect(t).toContain('Labour — ')
  })
  it('split block: kraft, 2px outline, divider, square, no shadow, no icon/chart', () => {
    const html = render(all({ revenueExVat: 1, salaryPct: 1, komboPct: 1, lemonadeUnits: 1 }))
    const block = html.slice(html.lastIndexOf('<div class="border-2', html.indexOf('Kombo %')))
    const outer = block.slice(0, block.indexOf('>'))
    expect(outer).toContain('border-2 border-[#171717]')
    expect(outer).toContain('bg-[#D2C3A7]')
    expect(outer).not.toMatch(/rounded|shadow/)
    expect(block).toContain('border-r-2 border-[#171717]')
    expect(block.slice(0, block.indexOf('Lemonades sold') + 200)).not.toMatch(/<svg|<canvas/)
  })
})
