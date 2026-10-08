import type { Media } from '@/lib/marketing/brain/types'
import type { MarketingBusinessContextItem } from '@/lib/marketing/brain/business-context'
import type { OrganicStrategyOutput, OrganicStrategyStored } from '@/lib/marketing/organic-strategy/types'
import { fingerprint, media } from './creative-brain'

export { fingerprint, media }
export const ORGANIC_NOW = new Date('2026-10-08T12:00:00Z')

/** A published post with no performance counters at all (unmeasured, NOT zero). */
export function unmeasured(n: number, over: Partial<Media> = {}): Media {
  return media(n, {
    reach: null, plays: null, shares: null, saved: null, comments_count: null, likes: null, total_interactions: null, other_metrics_json: null,
    published_at: `2026-0${(n % 8) + 1}-1${n % 9}T10:00:00Z`, ...over,
  })
}

/**
 * A small, realistic set: 8 measured videos and 1 measured carousel (the real account had 9 measured
 * posts in total) with invented subjects. Subjects are deliberately NOT the ones in the manual benchmark.
 */
export function smallMeasuredSet(): Media[] {
  const subjects: [string, number, number, number][] = [
    ['Why we marinate the chicken for 36 hours. Most places skip it.', 90_000, 700, 420],
    ['Falafel or hummus first? Settle it in the comments.', 30_000, 150, 60],
    ['Catering for 80 people in two hours. Here is how the line works.', 12_000, 40, 55],
    ['Our baker tried a rye flatbread. It went badly.', 8_000, 20, 10],
    ['New fries sauce, tested on the whole team.', 7_000, 15, 8],
    ['A normal Tuesday lunch rush at the Nørrebro shop.', 6_500, 14, 7],
    ['Meet the person who prepares the salad every morning.', 6_000, 12, 9],
    ['Open until 02:00 this weekend.', 5_500, 9, 3],
  ]
  const videos = subjects.map(([caption, plays, shares, saved], i) => media(i + 1, {
    caption, plays, reach: Math.round(plays * 0.6), shares, saved, likes: Math.round(plays / 30), comments_count: Math.round(plays / 400),
    total_interactions: shares + saved + Math.round(plays / 30), published_at: `2026-0${(i % 3) + 7}-${10 + i}T10:00:00Z`,
  }))
  const carousel = media(9, {
    media_type: 'CAROUSEL_ALBUM', caption: 'Five things on our menu you probably never tried.', plays: null, reach: 9_000,
    shares: 25, saved: 40, likes: 300, comments_count: 12, total_interactions: 377, published_at: '2026-09-20T10:00:00Z',
  })
  return [...videos, carousel]
}

export function businessItem(n: number, over: Partial<MarketingBusinessContextItem> = {}): MarketingBusinessContextItem {
  return {
    update_id: `update-${n}`, project_id: `project-${n}`, project_title: 'Killer Katering', parent_project_title: null,
    body: 'Delivered a 120 person lunch for a design studio. Two vans, done in 90 minutes.', occurred_on: '2026-10-01',
    created_at: '2026-10-01T10:00:00Z', age_days: 7, ...over,
  }
}

const learning = (n: number) => ({
  title: `Subject angle ${n} did better than product shots`,
  evidence: `P${n} reached 90,000 views with 700 shares; P2 and P3 reached 30,000 and 12,000 views. P4 reached 8,000.`,
  interpretation: 'One reading is that a clear question or claim in the caption gives people something to pass on.',
  evidence_strength: 'reasonable_inference' as const,
  limitations: 'Eight measured videos only. Visuals were not analysed and there is no retention data.',
})

export function validOutput(over: Partial<OrganicStrategyOutput> = {}): OrganicStrategyOutput {
  return {
    main_learnings: [learning(1), { ...learning(2), title: 'Explaining a hidden process drew shares' }],
    content_opportunities: [{
      title: 'Revisit the marinade subject from a new angle', why_now: 'It is the strongest measured subject and was last posted weeks ago.',
      evidence_basis: 'P1 reached 90,000 views and 700 shares, well above the video median.', suggested_angle: 'Show the part of the process people do not expect, in the caption first.',
      evidence_strength: 'weak_signal' as const,
    }],
    reel_concepts: [{
      concept_title: 'The 36 hour question', hook: 'Why does our chicken take a day and a half?',
      core_idea: 'Answer a question people already ask about how the chicken is made, using the process as the story.',
      execution: 'Open on the question as the first spoken line. Cut to the prep station and the marinade tub. Name the one step that surprises people. End on the finished plate.',
      why_this_is_worth_testing: 'P1 is the strongest measured post and its caption makes a specific claim about process.', evidence_basis: 'P1: 90,000 views, 700 shares.',
    }],
    carousel_concepts: [],
    ...over,
  }
}

export function storedStrategy(over: Partial<OrganicStrategyStored> = {}): OrganicStrategyStored {
  return {
    status: 'completed', generated_at: '2026-10-08T12:30:00Z', model: 'synthetic-model', prompt_version: '2026-10-08-v1',
    skill: { name: 'claude-ig', version: '2.0.0', ref: 'claude-ig@2.0.0#5e9b2d9', hash: 'a'.repeat(64) },
    evidence_window: { first_published: '2026-07-10', last_published: '2026-09-20', as_of: '2026-10-08' },
    evidence_summary: { stored_posts: 214, measured_posts: 9, unmeasured_posts: 205, measured_in_prompt: 9, unmeasured_in_prompt: 12, business_context_items: 2 },
    posts: [
      { ref: 'P1', published_at: '2026-09-20T10:00:00Z', media_type: 'CAROUSEL_ALBUM', permalink: 'https://www.instagram.com/p/abc/' },
      { ref: 'P2', published_at: '2026-07-10T10:00:00Z', media_type: 'VIDEO', permalink: null },
      { ref: 'U1', published_at: '2026-09-30T10:00:00Z', media_type: 'VIDEO', permalink: 'https://evil.example/p/x' },
    ],
    quality: { strength_downgrades: 0, unmatched_figures: [] },
    output: validOutput(), message: null, ...over,
  }
}
