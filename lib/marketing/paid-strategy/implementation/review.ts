import type { ExecutionLedger } from '../autonomous/types'
import type { ActivationReview, ImplementationMode } from './types'

const dkk = (n: number) => `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(n)} DKK`

/** Exactly what activation would switch on, from the verified ledger. Never platform IDs. */
export function activationReview(mode: ImplementationMode, ledger: ExecutionLedger | null): ActivationReview | null {
  if (!ledger || !ledger.evidence) return null
  const ev = ledger.evidence as Record<string, unknown>
  if (mode === 'campaign_creation' && ev.plan) {
    const p = ev.plan as { campaignName: string; adSetName: string; adName: string; objective: string; optimisation: string; geo: string; placements: string; dailyBudgetDkk: number; totalBudgetDkk: number; durationDays: number; destination: string | null; copy: string; reviewNotes: string[] }
    return {
      kind: 'campaign', title: p.campaignName,
      lines: [
        { label: 'Campaign', value: p.campaignName }, { label: 'Ad set', value: p.adSetName }, { label: 'Ad', value: p.adName },
        { label: 'Objective', value: p.objective }, { label: 'Optimisation', value: p.optimisation }, { label: 'Location', value: p.geo }, { label: 'Placements', value: p.placements },
        { label: 'Daily budget', value: dkk(p.dailyBudgetDkk) }, { label: 'Runs for', value: `${p.durationDays} days from activation` }, { label: 'Total reserved', value: dkk(p.totalBudgetDkk) },
        ...(p.destination ? [{ label: 'Destination', value: p.destination }] : []), { label: 'Ad copy', value: p.copy },
      ],
      notes: p.reviewNotes,
    }
  }
  if (mode === 'creative_execution' && ev.testDesign) {
    const t = ev.testDesign as { variable: string; changed: string[]; heldConstant: string[]; successMetric: string; durationDays: number; control: string; adSet: string; needsBusinessDecision: string[] }
    const pkg = ev.package as { headline: string; primary_text: string; description: string; cta: string; hook_options: string[] } | undefined
    return {
      kind: 'creative', title: pkg?.headline ?? 'New ad',
      lines: [
        ...(pkg ? [{ label: 'Headline', value: pkg.headline }, { label: 'Primary text', value: pkg.primary_text }, { label: 'Description', value: pkg.description }, { label: 'Call to action', value: pkg.cta }, { label: 'Other hooks', value: pkg.hook_options.join(' · ') }] : []),
        { label: 'Variable tested', value: t.variable }, { label: 'Changed', value: t.changed.join(', ') }, { label: 'Runs against', value: `${t.control}, in the same ad set (${t.adSet})` },
        { label: 'Success metric', value: t.successMetric }, { label: 'Test length', value: `${t.durationDays} days` },
      ],
      notes: [...t.heldConstant, ...(t.needsBusinessDecision.length ? [`Not used because the existing ad does not support it (your decision): ${t.needsBusinessDecision.join('; ')}.`] : []), 'Nothing is live: the new ad is paused until you activate it.'],
    }
  }
  return null
}
