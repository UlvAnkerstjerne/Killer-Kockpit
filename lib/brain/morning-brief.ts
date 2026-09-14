/**
 * lib/brain/morning-brief.ts
 *
 * Brain Marketing Morning Brief retrieval layer.
 *
 * fetchBrainMorningBriefContext({ maxBriefs? })
 * ─────────────────────────────────────────────
 * Fetches the most recent ready Marketing Morning Briefs.
 *
 * Data authority:
 *  - INTERNAL SUMMARY — synthesised from marketing platform integrations.
 *  - Lower authority than native Kockpit structured records (tasks, decisions).
 *  - The AI system prompt enforces: "Morning Brief is a derived summary,
 *    not a primary data source."
 *  - Sections assessments are AI-authored text — label accordingly.
 *
 * Security:
 *  - Uses createServiceClient (Brain is management-gated at the action layer).
 *  - Never includes deterministic_signals_json (SUPER_ADMIN only field).
 */

import { createServiceClient } from '@/lib/supabase/server'
import type { MorningBriefSections } from '@/lib/marketing/brief/types'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface BrainBriefSummary {
  briefDate:          string          // YYYY-MM-DD
  overallStatus:      string | null   // 'green' | 'amber' | 'red'
  overallReason:      string | null
  aiSummary:          string | null
  paidAssessment:     string | null
  organicAssessment:  string | null
  gbpAssessment:      string | null
}

export interface BrainMorningBriefContext {
  briefs: BrainBriefSummary[]
}

// ─── fetchBrainMorningBriefContext ────────────────────────────────────────────

/**
 * Fetches the most recent ready Marketing Morning Briefs.
 *
 * @param maxBriefs  Maximum number of briefs to return (default: 3)
 */
export async function fetchBrainMorningBriefContext({
  maxBriefs = 3,
}: {
  maxBriefs?: number
} = {}): Promise<BrainMorningBriefContext> {
  try {
    const db = createServiceClient()

    const { data, error } = await db
      .from('marketing_morning_briefs')
      .select('brief_date, overall_status, overall_reason, ai_summary, sections_json')
      .eq('status', 'ready')
      .not('ai_summary', 'is', null)
      .order('brief_date', { ascending: false })
      .limit(maxBriefs)

    if (error || !data) {
      return { briefs: [] }
    }

    const briefs: BrainBriefSummary[] = data.map(row => {
      const sections = row.sections_json as MorningBriefSections | null

      return {
        briefDate:         row.brief_date,
        overallStatus:     row.overall_status ?? null,
        overallReason:     row.overall_reason ?? null,
        aiSummary:         row.ai_summary ?? null,
        paidAssessment:    sections?.paid?.assessment ?? null,
        organicAssessment: sections?.organic?.assessment ?? null,
        gbpAssessment:     sections?.gbp?.assessment ?? null,
      }
    })

    return { briefs }
  } catch (err) {
    console.error('[brain/morning-brief] fetchBrainMorningBriefContext failed:', (err as Error).message)
    return { briefs: [] }
  }
}
