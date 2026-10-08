import type { ReactNode } from 'react'
import type {
  CarouselConcept, ContentOpportunity, EvidenceStrength, MainLearning, OrganicStrategyStored, ReelConcept,
} from '@/lib/marketing/organic-strategy/types'

/** Same bar the Brain uses for any format baseline (MIN_BASELINE_POSTS). */
const MIN_CAROUSELS_FOR_A_FORMAT_VIEW = 5

const STRENGTH: Record<EvidenceStrength, { label: string; hint: string; className: string }> = {
  proven_pattern: { label: 'Strong repeated pattern', hint: 'Repeated across several measured posts. Still a small dataset, not proof', className: 'bg-kk-brand text-white' },
  reasonable_inference: { label: 'Reasonable inference', hint: 'Supported by the data, but not repeated enough to call proven', className: 'border border-kk-line bg-kk-soft text-kk-ink' },
  weak_signal: { label: 'Weak signal', hint: 'Thin evidence, often a single post', className: 'border border-dashed border-kk-line text-kk-muted' },
}

const day = (value: string) => new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
function instagramHref(value: string | null): string | undefined {
  if (!value) return undefined
  try { const u = new URL(value); return u.protocol === 'https:' && ['instagram.com', 'www.instagram.com'].includes(u.hostname) ? u.href : undefined } catch { return undefined }
}

function Strength({ value }: { value: EvidenceStrength }) {
  const s = STRENGTH[value] ?? STRENGTH.weak_signal
  return <span title={s.hint} className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium ${s.className}`}>{s.label}</span>
}
function Label({ children }: { children: ReactNode }) {
  return <dt className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">{children}</dt>
}
function Block({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return <div>
    <h3 className="mb-3 flex items-baseline gap-2 text-base font-semibold">{title}{count != null ? <span className="text-xs font-normal text-kk-muted">{count}</span> : null}</h3>
    {children}
  </div>
}

function LearningCard({ item }: { item: MainLearning }) {
  return <article className="rounded-2xl border border-kk-line bg-kk-panel p-5">
    <div className="flex items-start justify-between gap-3"><h4 className="text-base font-semibold leading-snug">{item.title}</h4><Strength value={item.evidence_strength} /></div>
    <dl className="mt-3 space-y-3 text-sm leading-relaxed">
      <div><Label>What happened</Label><dd className="mt-0.5">{item.evidence}</dd></div>
      <div><Label>What it may mean</Label><dd className="mt-0.5">{item.interpretation}</dd></div>
    </dl>
    <p className="mt-3 text-xs leading-relaxed text-kk-muted">Limits: {item.limitations}</p>
  </article>
}

function OpportunityCard({ item }: { item: ContentOpportunity }) {
  return <article className="rounded-2xl border border-kk-line bg-kk-panel p-5">
    <div className="flex items-start justify-between gap-3"><h4 className="text-base font-semibold leading-snug">{item.title}</h4><Strength value={item.evidence_strength} /></div>
    <dl className="mt-3 space-y-3 text-sm leading-relaxed">
      <div><Label>Why now</Label><dd className="mt-0.5">{item.why_now}</dd></div>
      <div><Label>Worth trying</Label><dd className="mt-0.5">{item.suggested_angle}</dd></div>
    </dl>
    <p className="mt-3 text-xs leading-relaxed text-kk-muted">Based on: {item.evidence_basis}</p>
  </article>
}

function ReelCard({ item }: { item: ReelConcept }) {
  return <article className="rounded-2xl border border-kk-brand/40 bg-kk-panel p-5">
    <h4 className="text-base font-semibold leading-snug">{item.concept_title}</h4>
    <blockquote className="mt-3 border-l-4 border-kk-brand pl-3 text-base font-medium leading-snug">&ldquo;{item.hook}&rdquo;</blockquote>
    <dl className="mt-4 space-y-3 text-sm leading-relaxed">
      <div><Label>The idea</Label><dd className="mt-0.5">{item.core_idea}</dd></div>
      <div><Label>How to make it</Label><dd className="mt-0.5 whitespace-pre-line">{item.execution}</dd></div>
      <div><Label>Why test it</Label><dd className="mt-0.5">{item.why_this_is_worth_testing}</dd></div>
    </dl>
    <p className="mt-3 text-xs leading-relaxed text-kk-muted">Based on: {item.evidence_basis}</p>
  </article>
}

function CarouselCard({ item, exploratory }: { item: CarouselConcept; exploratory: boolean }) {
  return <article className={`rounded-2xl border bg-kk-panel p-5 ${exploratory ? 'border-kk-line' : 'border-kk-brand/40'}`}>
    <div className="flex items-start justify-between gap-3"><h4 className="text-base font-semibold leading-snug">{item.concept_title}</h4>{exploratory ? <span className="shrink-0 rounded-full border border-dashed border-kk-line px-2.5 py-1 text-[11px] font-medium text-kk-muted">Exploratory</span> : null}</div>
    <div className="mt-3"><Label>Opening slide</Label><p className="mt-0.5 border-l-4 border-kk-brand pl-3 text-base font-medium leading-snug">{item.opening_slide}</p></div>
    <div className="mt-4"><Label>Slides</Label>
      <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm leading-relaxed">{item.slide_structure.map((slide, i) => <li key={i}>{slide}</li>)}</ol>
    </div>
    <div className="mt-4 text-sm leading-relaxed"><Label>Why test it</Label><p className="mt-0.5">{item.why_this_is_worth_testing}</p></div>
    <p className="mt-3 text-xs leading-relaxed text-kk-muted">Based on: {item.evidence_basis}</p>
  </article>
}

function Frame({ children }: { children: ReactNode }) {
  return <section aria-labelledby="organic-strategy-title" className="space-y-4 rounded-3xl border border-kk-brand/25 bg-kk-soft/60 p-5 sm:p-6">
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-kk-brand">What to make next</p>
      <h2 id="organic-strategy-title" className="text-xl font-semibold">Organic strategy</h2>
      <p className="mt-1 text-xs text-kk-muted">Based on what has actually worked on Instagram · AI suggestions for human review</p>
    </div>
    {children}
  </section>
}

export default function OrganicStrategySection({ strategy, canRefresh }: { strategy: OrganicStrategyStored | undefined; canRefresh: boolean }) {
  if (!strategy) {
    return <Frame>
      <div className="rounded-2xl border border-kk-line bg-kk-panel px-6 py-8">
        <h3 className="text-base font-semibold">No Organic Strategy for this run yet</h3>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-kk-muted">{canRefresh ? 'Refresh Creative Intelligence to generate it from the posts that have performance data.' : 'A SUPER_ADMIN can generate it by refreshing Creative Intelligence.'}</p>
      </div>
    </Frame>
  }
  if (strategy.status !== 'completed' || !strategy.output) {
    const skipped = strategy.status === 'skipped'
    return <Frame>
      <div role={skipped ? 'status' : 'alert'} className="rounded-2xl border border-kk-line bg-kk-panel px-6 py-8">
        <h3 className="text-base font-semibold">{skipped ? 'Not enough measured posts yet' : 'Organic Strategy is unavailable for this run'}</h3>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-kk-muted">{strategy.message ?? 'It could not be generated.'}{skipped ? '' : canRefresh ? ' The rest of this page is unaffected. Refresh Creative Intelligence to try again.' : ' The rest of this page is unaffected.'}</p>
      </div>
    </Frame>
  }

  const { output: o, evidence_summary: s } = strategy
  // The window is deliberately NOT the Brain's 90 days: strong older posts are kept, so say which dates the evidence covers.
  const { first_published: first, last_published: last } = strategy.evidence_window
  const window = first && last ? (first === last ? day(first) : `${day(first)} to ${day(last)}`) : null
  // Measured carousels (P refs only). With fewer than 5 there is no format baseline, so carousel ideas are exploratory.
  const measuredCarousels = strategy.posts.filter(p => p.ref.startsWith('P') && p.media_type === 'CAROUSEL_ALBUM').length
  const exploratoryCarousels = measuredCarousels < MIN_CAROUSELS_FOR_A_FORMAT_VIEW
  const empty = !o.main_learnings.length && !o.content_opportunities.length && !o.reel_concepts.length && !o.carousel_concepts.length
  return <Frame>
    <p className="text-xs text-kk-muted">
      Generated {day(strategy.generated_at)} · based on {s.measured_in_prompt} post{s.measured_in_prompt === 1 ? '' : 's'} with performance data{window ? `, published ${window}` : ''} (of {s.stored_posts} stored; the rest have no metrics) · {strategy.skill?.ref ?? 'skill unknown'}{strategy.model ? ` · ${strategy.model}` : ''}
    </p>
    {empty ? <p className="rounded-xl border border-kk-line bg-kk-panel p-5 text-sm text-kk-muted">The data does not support a recommendation yet. That is a legitimate result with this few measured posts.</p> : null}
    {o.main_learnings.length ? <Block title="Main learnings" count={o.main_learnings.length}><div className="grid gap-4 lg:grid-cols-2">{o.main_learnings.map((x, i) => <LearningCard key={`${i}-${x.title}`} item={x} />)}</div></Block> : null}
    {o.content_opportunities.length ? <Block title="Content opportunities" count={o.content_opportunities.length}><div className="grid gap-4 lg:grid-cols-2">{o.content_opportunities.map((x, i) => <OpportunityCard key={`${i}-${x.title}`} item={x} />)}</div></Block> : null}
    {o.reel_concepts.length ? <Block title="Reel concepts" count={o.reel_concepts.length}><div className="grid gap-4 lg:grid-cols-3">{o.reel_concepts.map((x, i) => <ReelCard key={`${i}-${x.concept_title}`} item={x} />)}</div></Block> : null}
    {o.carousel_concepts.length ? (exploratoryCarousels
      // Thin evidence: keep the ideas available but closed, so they do not weigh as much as the Reels.
      ? <details className="rounded-2xl border border-dashed border-kk-line bg-kk-panel/60 p-4">
        <summary className="cursor-pointer">
          <h3 className="inline text-base font-semibold">Carousel concepts</h3><span className="ml-2 text-xs text-kk-muted">{o.carousel_concepts.length}</span>
          <span className="mt-1 block text-xs font-normal text-kk-muted">Exploratory: only {measuredCarousels} carousel{measuredCarousels === 1 ? '' : 's'} {measuredCarousels === 1 ? 'has' : 'have'} performance data, too few to show how the format performs.</span>
        </summary>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">{o.carousel_concepts.map((x, i) => <CarouselCard key={`${i}-${x.concept_title}`} item={x} exploratory />)}</div>
      </details>
      : <Block title="Carousel concepts" count={o.carousel_concepts.length}>
        <div className="grid gap-4 lg:grid-cols-3">{o.carousel_concepts.map((x, i) => <CarouselCard key={`${i}-${x.concept_title}`} item={x} exploratory={false} />)}</div>
      </Block>) : null}
    {strategy.posts.length ? <details className="rounded-xl border border-kk-line p-4 text-sm">
      <summary className="cursor-pointer font-medium">Posts behind these references ({strategy.posts.length})</summary>
      <p className="mt-2 text-xs text-kk-muted">P = has performance data. U = no metrics, listed only so already-covered subjects are known.</p>
      <ul className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">{strategy.posts.map(p => {
        const href = instagramHref(p.permalink)
        return <li key={p.ref} className="text-xs"><span className="font-semibold">{p.ref}</span> · {day(p.published_at)} · {p.media_type.toLowerCase().replace('_album', '')}{href ? <> · <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">view ↗</a></> : null}</li>
      })}</ul>
    </details> : null}
  </Frame>
}
