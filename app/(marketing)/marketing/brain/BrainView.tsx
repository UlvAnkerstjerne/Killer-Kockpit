import type { ReactNode } from 'react'
import type { BrainData } from '@/lib/actions/marketing/creative-intelligence'
import type { CreativeAnalytics, CreativePost, Dimension, MetricSummary } from '@/lib/marketing/brain/types'
import { label, signalEvidence } from '@/lib/marketing/brain/signals'
import { MIN_PATTERN_POSTS } from '@/lib/marketing/brain/analytics'
import IgThumbnail from '../organic/IgThumbnail'

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

export default function BrainView({ data, refreshControl }: { data: BrainData; refreshControl?: ReactNode }) {
  const run = data.run
  const analytics = run?.analytics
  return <div className="space-y-7 text-kk-ink">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-kk-muted">Instagram · Organic</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Marketing Brain</h1>
        <h2 className="mt-3 text-lg font-semibold">Creative Intelligence</h2>
        <p className="mt-2 text-sm text-kk-muted">What the Instagram evidence suggests testing next.</p></div>
      {data.canRefresh ? refreshControl : null}
    </header>
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
          <section aria-label="Analysis coverage" className="rounded-2xl border border-kk-line bg-kk-panel p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="font-semibold">Last 90 completed publication days</h2><span className="text-xs text-kk-muted">Updated {date(run.generated_at)} · {run.status === 'partial' ? 'Partial result' : 'Saved analysis'}</span></div>
            <p className="mt-1 text-sm text-kk-muted">{date(run.analysis_start)} – {date(new Date(Date.parse(run.analysis_end) - 1).toISOString())} · UTC</p>
            <div className="mt-5 grid grid-cols-3 gap-4 border-t border-kk-line pt-4">{[
              ['Published posts', analytics.coverage.total], ['With exposure', analytics.coverage.with_exposure], ['Classified', analytics.coverage.classified],
            ].map(([name, count]) => <div key={name}><p className="text-2xl font-semibold tabular-nums">{count}</p><p className="mt-1 text-xs text-kk-muted">{name}</p></div>)}</div>
            <p className="mt-4 text-xs leading-relaxed text-kk-muted">Stored lifetime performance of posts published in this window, not engagement earned during the window. Views and reach are kept separate. Post ages differ; individual metric refresh dates are unavailable. {analytics.coverage.stale_syncs > 0 ? `${analytics.coverage.stale_syncs} posts were last synced more than 14 days ago.` : ''}</p>
            {run.error ? <p role="status" className="mt-3 text-sm">{run.error}</p> : null}
          </section>
          <section aria-labelledby="working-title"><div className="mb-4 flex flex-wrap items-baseline justify-between gap-2"><h2 id="working-title" className="text-xl font-semibold">What’s working</h2><span className="text-xs text-kk-muted">AI hypotheses · for human review</span></div>
            <div className="grid gap-4 lg:grid-cols-2">{run.observations.length ? run.observations.map((observation, index) => {
              const signal = run.signals.find(s => s.id === observation.signal_id)
              return <article key={observation.signal_id} className="rounded-2xl border border-kk-line bg-kk-panel p-5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-kk-muted">Observation {index + 1} · {label(signal?.evidence_level ?? 'emerging')}</p>
                <h3 className="mt-2 text-lg font-semibold leading-snug">{observation.finding}</h3>
                <p className="mt-4 rounded-xl bg-kk-soft p-3 text-sm leading-relaxed"><strong className="block text-xs uppercase tracking-wide">Evidence</strong>{signal ? signalEvidence(signal) : observation.evidence}</p>
                <p className="mt-4 text-sm leading-relaxed"><strong className="block text-xs text-kk-muted">Hypothesis</strong>{observation.interpretation}</p>
                <p className="mt-4 border-t border-kk-line pt-3 text-sm leading-relaxed"><strong className="block text-xs text-kk-muted">Suggested test</strong>{observation.suggested_experiment}</p>
                {signal ? <details className="mt-4 text-xs text-kk-muted"><summary className="cursor-pointer">Supporting content and comparison</summary><p className="mt-2">Supporting posts</p><PostLinks ids={signal.supporting_media_ids} posts={analytics.posts} /><p className="mt-2">Comparison posts</p><PostLinks ids={signal.comparison_media_ids} posts={analytics.posts} /></details> : null}
              </article>
            }) : <p className="rounded-xl border border-kk-line bg-kk-panel p-5 text-sm text-kk-muted lg:col-span-2">{run.signals.length ? 'Deterministic signals are available below. No AI observations were produced for this run.' : 'No repeated pattern meets the material evidence threshold yet. The tables show the current sample without drawing a conclusion.'}</p>}</div>
            {run.signals.length ? <details className="mt-4 rounded-xl border border-kk-line p-4 text-sm"><summary className="cursor-pointer font-medium">View {run.signals.length} deterministic signals</summary><ul className="mt-3 space-y-3">{run.signals.map(signal => <li key={signal.id}><strong>{label(signal.value)} · {label(signal.type)}</strong><p className="mt-1 text-xs leading-relaxed text-kk-muted">{signalEvidence(signal)}</p></li>)}</ul></details> : null}
          </section>
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
          <section><h2 className="text-xl font-semibold">Exceptional content</h2><p className="mt-1 text-xs text-kk-muted">At least 3× its format median. Individual standouts are not proof of a repeated pattern.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{analytics.exceptional.map(post => <article key={post.id} className="overflow-hidden rounded-2xl border border-kk-line bg-kk-panel">
              <div className="aspect-[16/9] bg-kk-soft"><IgThumbnail src={preview(post.thumbnail_url)} /></div>
              <div className="space-y-3 p-4"><div className="flex justify-between gap-2 text-xs text-kk-muted"><span>{date(post.published_at)}</span><span>{label(post.format)}</span></div>
                <p className="text-xl font-semibold">{number(post.exposure)} {post.exposure_kind}</p><p className="text-sm">{number(post.normalized_exposure!)}× format median · {post.shares === null ? '—' : number(post.shares)} shares · {post.saves === null ? '—' : number(post.saves)} saves</p>
                <p className="text-xs leading-relaxed text-kk-muted">{post.fingerprint ? `${label(post.fingerprint.hook_type)} (${post.fingerprint.hook_source}) · ${label(post.fingerprint.primary_theme)} · ${label(post.fingerprint.product_focus)}` : 'Not classified'}</p>
                <p className="text-xs text-kk-muted">Last content sync {date(post.synced_at)}</p>
                {instagramLink(post.permalink) ? <a href={instagramLink(post.permalink)} target="_blank" rel="noopener noreferrer" className="inline-block text-sm font-medium underline underline-offset-4">View on Instagram ↗</a> : null}
              </div>
            </article>)}{analytics.exceptional.length === 0 ? <p className="text-sm text-kk-muted">No individual posts meet the exceptional-content threshold.</p> : null}</div>
          </section>
        </>}
        <footer className="space-y-2 border-t border-kk-line pt-4 text-xs leading-relaxed text-kk-muted">
          <p>Hook classification currently uses available caption/opening copy. Video opening analysis will be added separately.</p>
          <p>Taxonomy is AI-classified from captions and has not been manually verified. Visual presentation and human presence remain unknown without visual source material. Pattern groups need 3 measured posts; stronger evidence needs 8 posts on both sides of a comparison. Refresh is manual in v1.</p>
        </footer>
      </>}
  </div>
}
