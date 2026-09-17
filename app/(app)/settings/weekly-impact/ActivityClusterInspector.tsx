import type { ActivityAnalysis } from '@/lib/weekly-impact/types'

export default function ActivityClusterInspector({ analysis }: { analysis: ActivityAnalysis }) {
  return (
    <details className="rounded-xl border border-kk-line bg-kk-panel p-5" data-testid="activity-clusters">
      <summary className="cursor-pointer text-sm font-bold text-kk-ink">
        Activity clusters · {analysis.totalCompletedTodos} completed To-Dos reviewed
      </summary>
      <p className="mt-3 text-xs leading-relaxed text-kk-muted">
        {analysis.clusteredCompletedTodos} clustered · {analysis.unclusteredTodos.length} left unclustered with a reason.
        {' '}Themes cite {analysis.todoCitations.themes} distinct completed To-Dos; What moved cites {analysis.todoCitations.whatMoved}.
        {' '}Counts and titles come from source records. Grouping uses shared subject words before the AI; significance is interpretation, not measured effort or impact.
      </p>
      <div className="mt-4 space-y-3">
        {analysis.clusters.map(cluster => (
          <details key={cluster.id} className="rounded-lg border border-kk-line p-3">
            <summary className="cursor-pointer text-sm font-bold text-kk-ink">
              {cluster.heading} · {cluster.completedTodoCount} completed To-Dos
            </summary>
            <p className="mt-2 text-xs text-kk-muted">
              {cluster.usedInThemes ? 'Used in themes' : 'Not selected for themes'}
              {' · '}{cluster.usedInWhatMoved ? 'Used in What moved' : 'Not selected for What moved'}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-kk-ink">{cluster.rationale}</p>
            <h4 className="mt-3 text-xs font-bold uppercase tracking-wide text-kk-muted">Completed To-Dos</h4>
            {cluster.completedTodos.length ? (
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-kk-ink">
                {cluster.completedTodos.map(todo => <li key={todo.id} className="break-words">{todo.title}</li>)}
              </ul>
            ) : <p className="mt-1 text-xs text-kk-muted">None — deliverable or supporting context only.</p>}
            <h4 className="mt-3 text-xs font-bold uppercase tracking-wide text-kk-muted">Related Tasks</h4>
            <p className="mt-1 text-xs leading-relaxed text-kk-muted">
              {cluster.relatedTasks.length ? cluster.relatedTasks.map(task => task.title).join(' · ') : 'None recorded in this cluster.'}
              {cluster.relatedTasks.length > 0 ? ' (Grouped by subject; not a stored To-Do-to-Task link.)' : ''}
            </p>
            <h4 className="mt-3 text-xs font-bold uppercase tracking-wide text-kk-muted">Recorded Project context</h4>
            <p className="mt-1 text-xs leading-relaxed text-kk-muted">
              {cluster.relatedProjects.length ? cluster.relatedProjects.map(project => project.title ?? project.id).join(' · ') : 'No recorded Project link.'}
            </p>
            {(['person', 'location'] as const).map(kind => {
              const mentions = cluster.mentions.filter(mention => mention.kind === kind)
              return (
                <div key={kind} className="mt-3">
                  <h4 className="text-xs font-bold uppercase tracking-wide text-kk-muted">{kind === 'person' ? 'People' : 'Locations'} mentioned</h4>
                  {mentions.length ? (
                    <ul className="mt-1 space-y-1 text-xs leading-relaxed text-kk-muted">
                      {mentions.map((mention, index) => <li key={`${mention.evidenceId}-${index}`}>{mention.name}: “{mention.quote}”</li>)}
                    </ul>
                  ) : <p className="mt-1 text-xs text-kk-muted">None explicitly identified in this cluster.</p>}
                </div>
              )
            })}
          </details>
        ))}
      </div>
      {analysis.unclusteredTodos.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-bold text-kk-ink">Unclustered To-Dos</h3>
          <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-kk-ink">
            {analysis.unclusteredTodos.map(todo => <li key={todo.id}>{todo.title}<span className="block text-xs text-kk-muted">{todo.reason}</span></li>)}
          </ul>
        </div>
      ) : null}
      <p className="mt-4 text-xs leading-relaxed text-kk-muted">
        The existing evidence pack has no structured person/location links for To-Dos, so none are invented. Open commitments are excluded from these completed-work clusters.
      </p>
    </details>
  )
}
