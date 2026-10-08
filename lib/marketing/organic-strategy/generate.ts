/**
 * lib/marketing/organic-strategy/generate.ts
 *
 * Organic Strategy step of a Creative Intelligence refresh.
 *
 * FAILURE ISOLATION: runOrganicStrategy never throws and never touches the database. It returns
 * an OrganicStrategyStored the caller stores inside the run's analytics JSON. If the specialist
 * step cannot run or fails, the caller still has the deterministic evidence and the existing
 * creative interpretation, and the next refresh simply tries again.
 */

import 'server-only'
import type { createServiceClient } from '@/lib/supabase/server'
import { callOrganicStrategyAI, ORGANIC_STRATEGY_PROMPT_VERSION } from '@/lib/ai/organic-strategy'
import { loadClaudeIgSkill, type LoadedClaudeIgSkill } from '@/lib/ai/skills/claude-ig'
import type { MarketingBusinessContextItem } from '@/lib/marketing/brain/business-context'
import type { FingerprintRow } from '@/lib/marketing/brain/taxonomy'
import type { Media } from '@/lib/marketing/brain/types'
import { buildOrganicEvidence, MIN_MEASURED_POSTS_FOR_STRATEGY } from './evidence'
import type { OrganicStrategyStored } from './types'

type Db = ReturnType<typeof createServiceClient>

export interface RunOrganicStrategyArgs {
  media: Media[]
  fingerprints: FingerprintRow[]
  businessContext: MarketingBusinessContextItem[]
  followersLatest: number | null
  now: Date
  /** Test seams. */
  loadSkill?: () => LoadedClaudeIgSkill
  call?: typeof callOrganicStrategyAI
}

/** Latest known follower count, or null. A failure here must never affect the refresh. */
export async function loadLatestFollowers(db: Db): Promise<number | null> {
  try {
    const { data, error } = await db.from('meta_ig_account_daily').select('followers_count,date')
      .not('followers_count', 'is', null).order('date', { ascending: false }).limit(1)
    const n = Number(data?.[0]?.followers_count)
    return error || !Number.isFinite(n) || n < 0 ? null : n
  } catch {
    return null
  }
}

export async function runOrganicStrategy(args: RunOrganicStrategyArgs): Promise<OrganicStrategyStored> {
  const base = (over: Partial<OrganicStrategyStored>): OrganicStrategyStored => ({
    status: 'unavailable',
    generated_at: new Date().toISOString(),
    model: null,
    prompt_version: ORGANIC_STRATEGY_PROMPT_VERSION,
    skill: null,
    evidence_window: { first_published: null, last_published: null, as_of: args.now.toISOString().slice(0, 10) },
    evidence_summary: { stored_posts: 0, measured_posts: 0, unmeasured_posts: 0, measured_in_prompt: 0, unmeasured_in_prompt: 0, business_context_items: 0 },
    posts: [],
    quality: { strength_downgrades: 0, unmatched_figures: [] },
    output: null,
    message: null,
    ...over,
  })

  try {
    const built = buildOrganicEvidence({
      media: args.media, fingerprints: args.fingerprints, businessContext: args.businessContext,
      followersLatest: args.followersLatest, now: args.now,
    })
    const shared = { evidence_window: built.window, evidence_summary: built.summary, posts: built.refs }

    if (built.summary.measured_posts < MIN_MEASURED_POSTS_FOR_STRATEGY) {
      return base({
        ...shared, status: 'skipped',
        message: `Organic Strategy needs at least ${MIN_MEASURED_POSTS_FOR_STRATEGY} posts with performance metrics; ${built.summary.measured_posts} found. Nothing was sent to the model.`,
      })
    }

    let skill: LoadedClaudeIgSkill
    try {
      skill = (args.loadSkill ?? loadClaudeIgSkill)()
    } catch (err) {
      console.error('[organic-strategy] Skill verification failed:', err instanceof Error ? err.message : err)
      return base({ ...shared, message: 'The pinned claude-ig skill files could not be verified. No analysis was run.' })
    }
    const skillInfo = { name: skill.name, version: skill.version, ref: skill.ref, hash: skill.hash }

    const result = await (args.call ?? callOrganicStrategyAI)(skill, built.evidence, {
      measuredInPrompt: built.summary.measured_in_prompt,
      unmeasuredInPrompt: built.summary.unmeasured_in_prompt,
      businessItems: built.summary.business_context_items,
    })
    if (!result.ok) return base({ ...shared, skill: skillInfo, message: result.error })

    return base({
      ...shared, status: 'completed', skill: skillInfo, model: result.model,
      quality: { strength_downgrades: result.validated.strengthDowngrades, unmatched_figures: result.validated.unmatchedFigures },
      output: result.validated.output,
    })
  } catch (err) {
    console.error('[organic-strategy] Unexpected failure:', err instanceof Error ? err.message : err)
    return base({ message: 'Organic Strategy could not be prepared. The rest of the refresh is unaffected.' })
  }
}
