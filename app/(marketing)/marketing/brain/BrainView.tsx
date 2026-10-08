import type { ReactNode } from 'react'
import Link from 'next/link'
import type { BrainData } from '@/lib/actions/marketing/creative-intelligence'
import type { CreativeAnalytics, CreativePost, CreativeSignal, Dimension, MetricSummary, ObservationBusinessContext, BusinessContextSnapshot, Observation, Insight } from '@/lib/marketing/brain/types'
import { isInsight } from '@/lib/marketing/brain/types'
import { INTERPRETATION_PROMPT_VERSION } from '@/lib/marketing/brain/taxonomy'
import { label, signalEvidence, signalMetric, signalComparison } from '@/lib/marketing/brain/signals'
import { MIN_PATTERN_POSTS } from '@/lib/marketing/brain/analytics'
import IgThumbnail from '../organic/IgThumbnail'
import OrganicStrategySection from './OrganicStrategySection'

const number = (n: number) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(n)
function date(value: string) { return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) }
export function instagramLink(value: string | null): string | undefined {
  if (!value) return undefined
  try { const u = new URL(value); return u.protocol === 'https:' && ['instagram.com', 'www.instagram.com'].includes(u.hostname) ? u.href : undefined } catch { return undefined }
}
function preview(value: string | null): string | null {
  try { return value && new URL(value).protocol === 'https:' ? value : null } catch { return null }
}
function Metric({ metric, suffix = '' }: { metric: MetricSummary; suffix?: string }) {
  return metric.value === null || metric.count < MIN_PATTERN_POSTS
    ? <span className="text-kk-muted" title={`Insufficient evidence (${metric.count} measured posts)`}>—</span>
    : <span title={`${metric.count} measured posts`}>{number(metric.value)}{suffix}<span className="ml-1 text-[10px] text-kk-muted">n={metric.count}</span></span>
}
function PatternTable({ title, dimension, analytics }: { title: string; dimension: Dimension; analytics: CreativeAnalytics }) {
  const all = analytics.patterns.filter(p => p.dimension === dimension)
  const rows = all.filter(p => p.count >= MIN_PATTERN_POSTS && !['unknown', 'other', 'none', 'no_clear_hook'].includes(p.value))
  return <section className="overflow-hidden rounded-2xl border border-kk-line bg-kk-panel">
    <div className="border-b border-kk-line px-5 py-4"><h3 className="font-semibold text-kk-ink">{title}</h3></div>
    {rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm">
      <thead className="bg-kk-soft text-[11px] uppercase tracking-wide text-kk-muted"><tr>
        <th scope="col" className="px-5 py-3">Pattern / format</th><th scope="col" className="px-3 py-3">Posts</th><th scope="col" className="px-3 py-3">Exposure vs<br />format median</th><th scope="col" className="px-3 py-3">Shares / 1k</th><th scope="col" className="px-3 py-3">Saves / 1k</th>
      </tr></thead>
      <tbody>{rows.map(p => <tr key={p.id} className="border-t border-kk-line">
        <th scope="row" className="px-5 py-3 font-medium">{label(p.value)}<span className="mt-1 block text-xs font-normal text-kk-muted">{label(p.format)} · per 1k {p.exposure_kind}{analytics.formats.some(f => f.account_id !== p.account_id) ? ` · ${p.account_id}` : ''}</span></th>
        <td className="px-3 py-3 tabular-nums">{p.count}<span className="block text-[10px] text-kk-muted">{label(p.evidence_level)}</span></td>
        <td className="px-3 py-3 tabular-nums"><Metric metric={p.normalized_exposure} suffix="×" /></td>
        <td className="px-3 py-3 tabular-nums"><Metric metric={p.share_rate} /></td><td className="px-3 py-3 tabular-nums"><Metric metric={p.save_rate} /></td>
      </tr>)}</tbody>
    </table></div> : <p className="px-5 py-6 text-sm text-kk-muted">Insufficient evidence. A known pattern needs at least 3 classified posts in the same format.</p>}
    <p className="border-t border-kk-line px-5 py-3 text-xs text-kk-muted">Ranked by median exposure relative to format. {all.filter(p => p.count < 3).length} sparse groups omitted. Rates use measured posts only.</p>
  </section>
}
function PostLinks({ ids, posts }: { ids: string[]; posts: CreativePost[] }) {
  return <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">{ids.map(id => {
    const post = posts.find(p => p.id === id)
    const href = instagramLink(post?.permalink ?? null)
    return <li key={id}>{href ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{post ? date(post.published_at) : id} ↗</a> : <span>{id}</span>}</li>
  })}</ul>
}

// ---------------------------------------------------------------------------
// Classification chips
// ---------------------------------------------------------------------------

function ClassificationChips({ post }: { post: CreativePost }) {
  if (!post.fingerprint) return null
  const fp = post.fingerprint
  const chips: string[] = []
  if (fp.hook_type && !['unknown', 'no_clear_hook', 'none', 'other'].includes(fp.hook_type)) chips.push(label(fp.hook_type))
  if (fp.primary_theme && !['unknown', 'other'].includes(fp.primary_theme)) chips.push(label(fp.primary_theme))
  if (fp.product_focus && !['unknown', 'none', 'general_brand'].includes(fp.product_focus)) chips.push(label(fp.product_focus))
  if (!chips.length) return null
  return <p className="text-xs text-kk-muted">{chips.slice(0, 3).join(' · ')}</p>
}

// ---------------------------------------------------------------------------
// Representative content
// ---------------------------------------------------------------------------

/** Select a representative post for a signal: exact post for exceptional, strongest for patterns. */
export function representativePost(signal: CreativeSignal, posts: CreativePost[]): CreativePost | null {
  if (signal.type === 'exceptional_post') {
    return posts.find(p => p.id === signal.supporting_media_ids[0]) ?? null
  }
  const candidates = signal.supporting_media_ids
    .map(id => posts.find(p => p.id === id))
    .filter((p): p is CreativePost => p !== null)
  if (!candidates.length) return null
  return candidates.sort((a, b) => (b.normalized_exposure ?? 0) - (a.normalized_exposure ?? 0) || b.exposure - a.exposure)[0]
}

// ---------------------------------------------------------------------------
// Business Context
// ---------------------------------------------------------------------------

const ROLE_LABELS: Record<string, string> = {
  proof_point: 'Proof point', timely_angle: 'Timely angle',
  case_study: 'Case study', subject_matter: 'Subject matter',
}
function BusinessContextBlock({ ctx }: { ctx: ObservationBusinessContext }) {
  return <div className="rounded-lg border border-amber-200 bg-amber-50/40 px-3 py-2.5">
    <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-amber-700 mb-1">Business context</p>
    <p className="text-sm font-medium text-kk-ink">{ctx.project_title}{ctx.occurred_on ? <span className="ml-2 font-normal text-kk-muted">{date(ctx.occurred_on)}</span> : null}</p>
    <p className="mt-0.5 text-xs leading-relaxed text-kk-muted">&ldquo;{ctx.excerpt}&rdquo;</p>
    <p className="mt-1 text-[10px] text-amber-700">{ROLE_LABELS[ctx.role] ?? ctx.role}</p>
  </div>
}
function BusinessContextOverview({ items }: { items: BusinessContextSnapshot[] }) {
  if (!items.length) return null
  return <details className="mt-4 rounded-xl border border-kk-line p-4 text-sm">
    <summary className="cursor-pointer font-medium text-kk-ink">Business context available to Brain <span className="ml-1 text-xs text-kk-muted">· {items.length} item{items.length !== 1 ? 's' : ''}</span></summary>
    <div className="mt-3 space-y-2">{items.map(item => <div key={item.update_id} className="flex items-baseline justify-between gap-3 text-xs border-b border-kk-line pb-2 last:border-0">
      <div className="min-w-0 flex-1">
        <Link href={`/projects/${item.project_id}`} className="font-medium text-kk-ink hover:underline">{item.project_title}</Link>
        {item.parent_project_title ? <span className="ml-1 text-kk-muted">({item.parent_project_title})</span> : null}
        <p className="mt-0.5 text-kk-muted truncate">{item.body.slice(0, 120)}{item.body.length > 120 ? '...' : ''}</p>
      </div>
      <span className="shrink-0 text-kk-muted tabular-nums">{item.occurred_on ? date(item.occurred_on) : `${item.age_days}d ago`}</span>
    </div>)}</div>
  </details>
}

// ---------------------------------------------------------------------------
// Observation card
// ---------------------------------------------------------------------------

function ObservationCard({ observation, signal, posts }: { observation: Observation; signal: CreativeSignal | undefined; posts: CreativePost[] }) {
  const post = signal ? representativePost(signal, posts) : null
  const isIndividual = signal?.evidence_level === 'individual'
  const postLabel = isIndividual ? null : 'Example supporting post'
  const evidenceLabel = signal ? label(signal.evidence_level) : 'Emerging'

  return <article className="overflow-hidden rounded-2xl border border-kk-line bg-kk-panel">
    {/* Top bar: evidence level + format */}
    <div className="flex items-center gap-2 px-5 pt-4 pb-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-kk-muted">{evidenceLabel}</span>
      {signal ? <span className="text-[10px] uppercase tracking-[0.1em] text-kk-muted">· {label(signal.format)}</span> : null}
    </div>

    {/* Content + metric row */}
    <div className="flex gap-4 px-5 pb-3">
      {post ? <div className="shrink-0">
        <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-lg overflow-hidden bg-kk-soft">
          <IgThumbnail src={preview(post.thumbnail_url)} />
        </div>
        {postLabel ? <p className="mt-1 text-[10px] text-kk-muted text-center">{postLabel}</p> : null}
      </div> : null}
      <div className="min-w-0 flex-1">
        {signal ? <p className="text-2xl font-semibold tabular-nums tracking-tight">{signalMetric(signal)}</p> : null}
        {signal ? <p className="mt-0.5 text-xs text-kk-muted tabular-nums">{signalComparison(signal)}</p> : null}
        {post ? <><ClassificationChips post={post} /><p className="mt-1 text-xs text-kk-muted">{date(post.published_at)} · {label(post.format)}{instagramLink(post.permalink) ? <> · <a href={instagramLink(post.permalink)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">View ↗</a></> : null}</p></> : null}
      </div>
    </div>

    {/* Headline */}
    <div className="px-5 pb-3">
      <h3 className="text-base font-semibold leading-snug">{observation.finding}</h3>
    </div>

    {/* Three-layer structure */}
    <div className="space-y-3 px-5 pb-5">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-kk-muted mb-0.5">What we learned</p>
        <p className="text-sm leading-relaxed">{observation.interpretation}</p>
      </div>
      {observation.business_context ? <BusinessContextBlock ctx={observation.business_context} /> : null}
      <div className="border-t border-kk-line pt-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-kk-muted mb-0.5">Try next</p>
        <p className="text-sm leading-relaxed">{observation.suggested_experiment}</p>
      </div>
      {signal ? <details className="text-xs text-kk-muted">
        <summary className="cursor-pointer">Evidence and supporting content</summary>
        <p className="mt-2 text-xs leading-relaxed">{signalEvidence(signal)}</p>
        <p className="mt-2">Supporting posts</p>
        <PostLinks ids={signal.supporting_media_ids} posts={posts} />
        <p className="mt-2">Comparison posts</p>
        <PostLinks ids={signal.comparison_media_ids} posts={posts} />
      </details> : null}
    </div>
  </article>
}

// ---------------------------------------------------------------------------
// v2 Insight card + Brain's take
// ---------------------------------------------------------------------------

function BrainTake({ text }: { text: string }) {
  return <section aria-label="Brain's take" className="rounded-2xl border-2 border-[#171717] bg-kk-panel px-5 py-4 [box-shadow:4px_4px_0_#555555]">
    <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-kk-muted mb-1">Brain&rsquo;s take</p>
    <p className="text-base leading-relaxed">{text}</p>
  </section>
}

function InsightCard({ insight, signals, posts }: { insight: Insight; signals: CreativeSignal[]; posts: CreativePost[] }) {
  const used = insight.signal_ids.map(id => signals.find(s => s.id === id)).filter((s): s is CreativeSignal => !!s)
  const thumbs = used.map(s => ({ signal: s, post: representativePost(s, posts) })).filter((t): t is { signal: CreativeSignal; post: CreativePost } => !!t.post)
  return <article className="overflow-hidden rounded-2xl border border-kk-line bg-kk-panel">
    <div className="px-5 pt-5">
      <h3 className="text-lg font-semibold leading-snug">{insight.headline}</h3>
      <p className="mt-2 text-sm leading-relaxed">{insight.take}</p>
    </div>
    {used.length ? <div className="mt-4 space-y-3 px-5">
      {used.map(signal => {
        const post = thumbs.find(t => t.signal.id === signal.id)?.post
        return <div key={signal.id} className="flex items-center gap-3 rounded-xl bg-kk-soft/60 p-2.5">
          {post ? <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-kk-soft"><IgThumbnail src={preview(post.thumbnail_url)} /></div> : null}
          <div className="min-w-0">
            <p className="text-lg font-semibold tabular-nums leading-tight">{signalMetric(signal)}</p>
            <p className="text-xs text-kk-muted tabular-nums">{signalComparison(signal)} · {label(signal.evidence_level)} · {label(signal.format)}</p>
            {post ? <p className="text-xs text-kk-muted">{date(post.published_at)}{instagramLink(post.permalink) ? <> · <a href={instagramLink(post.permalink)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">View on Instagram ↗</a></> : null}</p> : null}
          </div>
        </div>
      })}
    </div> : null}
    <div className="space-y-3 px-5 pb-5 pt-4">
      {insight.business_context?.map(ctx => <BusinessContextBlock key={ctx.update_id} ctx={ctx} />)}
      <div className="border-t border-kk-line pt-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-kk-muted mb-0.5">Try next</p>
        <p className="text-sm leading-relaxed">{insight.next_move}</p>
      </div>
      {used.length ? <details className="text-xs text-kk-muted">
        <summary className="cursor-pointer">Evidence and supporting content</summary>
        {used.map(signal => <div key={signal.id} className="mt-2">
          <p className="leading-relaxed">{signalEvidence(signal)}</p>
          <p className="mt-1">Supporting posts</p><PostLinks ids={signal.supporting_media_ids} posts={posts} />
          <p className="mt-1">Comparison posts</p><PostLinks ids={signal.comparison_media_ids} posts={posts} />
        </div>)}
      </details> : null}
    </div>
  </article>
}

// ---------------------------------------------------------------------------
// Compact coverage
// ---------------------------------------------------------------------------

function CoverageSummary({ run, analytics }: { run: { generated_at: string; analysis_start: string; analysis_end: string; status: string; error: string | null; prompt_version: string }; analytics: CreativeAnalytics }) {
  return <section aria-label="Analysis coverage" className="rounded-xl border border-kk-line bg-kk-panel px-5 py-3">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <p className="text-sm text-kk-ink">
        <span className="font-medium">Last 90 days</span>
        <span className="mx-1.5 text-kk-muted">·</span>{analytics.coverage.total} post{analytics.coverage.total !== 1 ? 's' : ''}
        <span className="mx-1.5 text-kk-muted">·</span>{analytics.coverage.with_exposure} measured
        <span className="mx-1.5 text-kk-muted">·</span>{analytics.coverage.classified} classified
      </p>
      <span className="text-xs text-kk-muted">Updated {date(run.generated_at)}{run.status === 'partial' ? ' · Partial' : ''}
        {run.prompt_version !== INTERPRETATION_PROMPT_VERSION ? <span data-testid="stale-brain-version" className="block text-right text-[11px]">Generated with an older Brain version · Refresh recommended</span> : null}</span>
    </div>
    <details className="mt-2 text-xs text-kk-muted">
      <summary className="cursor-pointer">Analysis details</summary>
      <div className="mt-2 space-y-1.5 leading-relaxed">
        <p>{date(run.analysis_start)} – {date(new Date(Date.parse(run.analysis_end) - 1).toISOString())} · UTC</p>
        <p>Stored lifetime performance of posts published in this window, not engagement earned during the window. Views and reach are kept separate. Post ages differ; individual metric refresh dates are unavailable.</p>
        {analytics.coverage.stale_syncs > 0 ? <p>{analytics.coverage.stale_syncs} posts were last synced more than 14 days ago.</p> : null}
      </div>
    </details>
    {run.error ? <p role="status" className="mt-2 text-sm">{run.error}</p> : null}
  </section>
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function BrainView({ data, refreshControl, paidStrategy }: { data: BrainData; refreshControl?: ReactNode; paidStrategy?: ReactNode }) {
  const run = data.run
  const analytics = run?.analytics
  return <div className="space-y-6 text-kk-ink">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Marketing Brain</h1>
        <p className="mt-2 text-sm text-kk-muted">What we&rsquo;re learning from our marketing — and what to test next.</p>
        <p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-kk-muted">Creative Intelligence · Instagram Organic</p>
      </div>
      {data.canRefresh ? refreshControl : null}
    </header>
    {paidStrategy}
    {!data.allowed ? <p className="rounded-xl border border-kk-line bg-kk-panel p-5">Organic / Marketing access with paid_manage permission is required.</p>
      : data.error ? <p role="alert" className="rounded-xl border border-kk-line bg-kk-panel p-5">{data.error}</p>
      : <>
        {data.latestAttempt?.status === 'running' ? <p role="status" className="text-sm text-kk-muted">A refresh is running. The last saved result remains available.</p> : null}
        {data.latestAttempt?.status === 'failed' ? <p role="alert" className="rounded-xl border border-kk-line bg-kk-panel p-4 text-sm">{data.latestAttempt.error} {run ? 'Showing the last saved result below.' : ''}</p> : null}
        {!run || !analytics ? <section className="rounded-2xl border border-kk-line bg-kk-panel px-6 py-12">
          <h2 className="text-lg font-semibold">No Creative Intelligence run yet</h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-kk-muted">Refresh to classify eligible Instagram content and compare its performance. Patterns appear only when there is enough measured content to support them.</p>
          {!data.canRefresh ? <p className="mt-4 text-sm text-kk-muted">A SUPER_ADMIN can generate the first analysis.</p> : null}
        </section> : <>
          <CoverageSummary run={run} analytics={analytics} />
          <section aria-labelledby="learning-title">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-kk-muted">What the evidence says</p>
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="learning-title" className="text-xl font-semibold">What we&rsquo;re learning</h2>
              <span className="text-xs text-kk-muted">AI hypotheses · for human review</span>
            </div>
            {analytics.brain_take ? <div className="mb-4"><BrainTake text={analytics.brain_take} /></div> : null}
            <div className="grid gap-4 lg:grid-cols-2">{run.observations.length ? run.observations.map(observation => isInsight(observation)
              ? <InsightCard key={observation.signal_ids.join('|')} insight={observation} signals={run.signals} posts={analytics.posts} />
              : <ObservationCard key={observation.signal_id} observation={observation} signal={run.signals.find(s => s.id === observation.signal_id)} posts={analytics.posts} />
            ) : analytics.brain_take ? null : <p className="rounded-xl border border-kk-line bg-kk-panel p-5 text-sm text-kk-muted lg:col-span-2">{run.signals.length ? 'Deterministic signals are available below. No AI observations were produced for this run.' : 'No repeated pattern meets the material evidence threshold yet. The tables show the current sample without drawing a conclusion.'}</p>}</div>
            {run.signals.length ? <details className="mt-4 rounded-xl border border-kk-line p-4 text-sm"><summary className="cursor-pointer font-medium">View {run.signals.length} deterministic signals</summary><ul className="mt-3 space-y-3">{run.signals.map(signal => <li key={signal.id}><strong>{label(signal.value)} · {label(signal.type)}</strong><p className="mt-1 text-xs leading-relaxed text-kk-muted">{signalEvidence(signal)}</p></li>)}</ul></details> : null}
            {analytics.business_context?.length ? <BusinessContextOverview items={analytics.business_context} /> : null}
          </section>
          <OrganicStrategySection strategy={analytics.organic_strategy} canRefresh={data.canRefresh} />
          <PatternTable title="Best hooks · caption copy" dimension="hook_type" analytics={analytics} />
          <PatternTable title="Best themes" dimension="primary_theme" analytics={analytics} />
          <PatternTable title="Best products / topics" dimension="product_focus" analytics={analytics} />
          <section className="rounded-2xl border border-kk-line bg-kk-panel p-5"><h2 className="text-lg font-semibold">Format performance</h2><p className="mt-1 text-xs text-kk-muted">Video uses views; carousel and image use reach. A format baseline needs at least 5 posts.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">{(['reel_video', 'carousel', 'image'] as const).map(format => {
              const groups = analytics.formats.filter(f => f.format === format)
              return <div key={format} className="rounded-xl border border-kk-line p-4"><h3 className="text-sm font-semibold">{label(format)}</h3>{groups.length ? groups.map(f => <div key={f.account_id} className="mt-3">
                <p className="text-xl font-semibold tabular-nums">{f.median_exposure === null ? '—' : number(f.median_exposure)}</p><p className="mt-1 text-xs text-kk-muted">Median {f.exposure_kind} · {f.count} posts</p>
                <p className="mt-3 text-xs text-kk-muted">Shares / 1k: <Metric metric={f.share_rate} /><br />Saves / 1k: <Metric metric={f.save_rate} /></p>
                {f.count < 5 ? <p className="mt-2 text-xs text-kk-muted">Insufficient format baseline</p> : null}
                {groups.length > 1 ? <p className="mt-2 text-xs text-kk-muted">Account {f.account_id}</p> : null}
              </div>) : <p className="mt-3 text-sm text-kk-muted">No measured posts</p>}</div>
            })}</div>
          </section>
          {analytics.exceptional.length > 0 ? <details className="rounded-2xl border border-kk-line bg-kk-panel p-5">
            <summary className="cursor-pointer"><h2 className="inline text-lg font-semibold">Exceptional content</h2><span className="ml-2 text-xs text-kk-muted">{analytics.exceptional.length} post{analytics.exceptional.length !== 1 ? 's' : ''} · 3× format median or above</span></summary>
            <p className="mt-2 text-xs text-kk-muted">Individual standouts are not proof of a repeated pattern.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{analytics.exceptional.map(post => <article key={post.id} className="overflow-hidden rounded-xl border border-kk-line">
              <div className="aspect-[16/9] bg-kk-soft"><IgThumbnail src={preview(post.thumbnail_url)} /></div>
              <div className="space-y-2 p-3"><div className="flex justify-between gap-2 text-xs text-kk-muted"><span>{date(post.published_at)}</span><span>{label(post.format)}</span></div>
                <p className="text-lg font-semibold tabular-nums">{number(post.normalized_exposure!)}× format median</p>
                <p className="text-xs text-kk-muted">{number(post.exposure)} {post.exposure_kind} · {post.shares === null ? '—' : number(post.shares)} shares · {post.saves === null ? '—' : number(post.saves)} saves</p>
                <ClassificationChips post={post} />
                {instagramLink(post.permalink) ? <a href={instagramLink(post.permalink)} target="_blank" rel="noopener noreferrer" className="inline-block text-xs font-medium underline underline-offset-4">View on Instagram ↗</a> : null}
              </div>
            </article>)}</div>
          </details> : null}
        </>}
        <footer className="space-y-2 border-t border-kk-line pt-4 text-xs leading-relaxed text-kk-muted">
          <p>Hook classification currently uses available caption/opening copy. Video opening analysis will be added separately.</p>
          <p>Taxonomy is AI-classified from captions and has not been manually verified. Visual presentation and human presence remain unknown without visual source material. Pattern groups need 3 measured posts; stronger evidence needs 8 posts on both sides of a comparison. Refresh is manual in v1.</p>
        </footer>
      </>}
  </div>
}
