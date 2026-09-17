import type { ActivityAnalysis, ActivityCluster, ImpactEvidenceItem, WeeklyImpactBrief, WeeklyImpactEvidence } from './types'

export const isOperationalEvidence = (item: Pick<ImpactEvidenceItem, 'title'>) => !/\b(?:QA record|test record|placeholder|not operational|non-operational)\b/i.test(item.title)
const STOP_WORDS = new Set('the a an and or for to with of in on at from into about our your this that create build prepare update review check confirm complete completed send call plan tjek ring opdater sammenlign bedre automatisk sæt set up add med og til fra på af den det en et i om vedrørende giv konkret svar mandag fredag tomorrow wednesday kockpit cockpit killer'.split(' '))
// Normalise common English/Danish subject words; these are not predetermined email themes.
function subjects(title: string): Set<string> {
  const text = title.toLocaleLowerCase('en')
    .replace(/\b(?:e-?mail\w*)\b/g, 'email')
    .replace(/(?:møde\w*|meeting\w*|agenda)/g, 'meeting')
    .replace(/\b(?:skilt\w*|neonsign|signage)\b/g, 'signage')
    .replace(/(?:åbningstid\w*|lukketid\w*|opening hours|closing hours)/g, 'hours')
  return new Set((text.match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length > 2 && !STOP_WORDS.has(word)))
}
const unique = (items: ImpactEvidenceItem[]) => [...new Map(items.map(item => [item.id, item])).values()]

/** Reproducible grouping before the AI; ambiguous relationships remain unclustered. */
export function buildActivityAnalysis(evidence: WeeklyImpactEvidence): ActivityAnalysis {
  const todos = unique(evidence.completedTodos)
  const tasks = unique(evidence.completedTasks).filter(isOperationalEvidence)
  const availableTodos = todos.filter(isOperationalEvidence)
  const tokens = new Map([...availableTodos, ...tasks].map(item => [item.id, subjects(item.title)]))
  const assigned = new Set<string>()
  const clusters: ActivityCluster[] = []
  const add = (heading: string, members: ImpactEvidenceItem[], rationale: string) => {
    members.forEach(item => assigned.add(item.id))
    const completedTodos = members.filter(item => item.kind === 'todo').map(({ id, title }) => ({ id, title }))
    const projects = new Map(members.filter(item => item.projectId).map(item => [item.projectId!, { id: item.projectId!, title: item.projectTitle }]))
    clusters.push({ id: `cluster-${clusters.length + 1}`, heading, rationale, evidenceIds: members.map(item => item.id),
      completedTodoCount: completedTodos.length, completedTodos,
      relatedTasks: members.filter(item => item.kind === 'task').map(({ id, title }) => ({ id, title })),
      relatedProjects: [...projects.values()], mentions: [], usedInThemes: false, usedInWhatMoved: false })
  }
  const candidates = [...new Set(availableTodos.flatMap(item => [...tokens.get(item.id)!]))]
    .map(subject => ({ subject, count: availableTodos.filter(item => tokens.get(item.id)!.has(subject)).length }))
    .sort((a, b) => b.count - a.count || a.subject.localeCompare(b.subject))
  for (const { subject } of candidates) {
    const members = availableTodos.filter(item => !assigned.has(item.id) && tokens.get(item.id)!.has(subject))
    if (!members.length) continue
    const shared = new Set(members.flatMap(item => [...tokens.get(item.id)!]))
    const related = tasks.filter(item => !assigned.has(item.id) && [...tokens.get(item.id)!].some(token => shared.has(token)))
    if (members.length < 2 && !related.some(task => tokens.get(task.id)!.has(subject))) continue
    add(subject[0].toUpperCase() + subject.slice(1), [...members, ...related], `Shared subject: ${subject}. Related Tasks share explicit subject words with the completed To-Dos.`)
  }
  for (const task of tasks) {
    if (assigned.has(task.id)) continue
    const related = tasks.filter(other => !assigned.has(other.id) && [...tokens.get(task.id)!].some(token => tokens.get(other.id)!.has(token)))
    add(task.title, related.length ? related : [task], 'Larger deliverable(s); no supported To-Do relationship was found. Shared project ownership alone does not group work.')
  }
  return { clusters, totalCompletedTodos: todos.length,
    clusteredCompletedTodos: clusters.reduce((sum, cluster) => sum + cluster.completedTodoCount, 0),
    unclusteredTodos: todos.filter(item => !assigned.has(item.id)).map(({ id, title }) => ({ id, title,
      reason: isOperationalEvidence({ title }) ? 'No sufficiently clear shared subject or related Task in the available records.' : 'Explicitly marked as non-operational evidence.' })),
    todoCitations: { themes: 0, whatMoved: 0 } }
}

/** AI references short labels; the server owns UUID mapping and all counts. */
export function buildSynthesisInput(evidence: WeeklyImpactEvidence, analysis: ActivityAnalysis) {
  const references = new Map<string, string[]>()
  const describe = (item: ImpactEvidenceItem, id: string) => {
    references.set(id, [item.id])
    return { id, kind: item.kind, title: item.title, detail: item.detail, date: item.occurredAt, status: item.status, attribution: item.attribution, project: item.projectTitle }
  }
  const context = [...evidence.movedProjects, ...evidence.resolvedWaitingOns, ...evidence.decisions, ...evidence.authoredUpdates, ...evidence.meetings].filter(isOperationalEvidence)
  const input = {
    person: evidence.user.name, week: evidence.week.displayRange,
    activityClusters: analysis.clusters.map(cluster => {
      references.set(cluster.id, cluster.evidenceIds)
      return { id: cluster.id, theme: cluster.heading, completedTodoCount: cluster.completedTodoCount,
        todoTitles: cluster.completedTodos.map(todo => todo.title),
        todoEvidence: evidence.completedTodos.filter(todo => cluster.evidenceIds.includes(todo.id)).map(todo => ({ title: todo.title, detail: todo.detail, date: todo.occurredAt, attribution: todo.attribution })),
        relatedTasks: evidence.completedTasks.filter(task => cluster.evidenceIds.includes(task.id)).map(task => ({ title: task.title, detail: task.detail, attribution: task.attribution })),
        relatedProjects: cluster.relatedProjects.map(project => project.title), people: [], locations: [], groupingBasis: cluster.rationale }
    }),
    unclusteredTodos: analysis.unclusteredTodos.filter(isOperationalEvidence).map((todo, index) => {
      const source = evidence.completedTodos.find(item => item.id === todo.id)!
      return { ...describe(source, `unclustered-${index + 1}`), reason: todo.reason }
    }),
    supportingContext: context.map((item, index) => describe(item, `context-${index + 1}`)),
    nextWeek: evidence.nextWeek.map((item, index) => describe(item, `next-${index + 1}`)),
  }
  return { input, references }
}

export function resolveBriefReferences(brief: WeeklyImpactBrief, references: Map<string, string[]>): WeeklyImpactBrief {
  const resolve = (ids: string[], next: boolean) => [...new Set(ids.flatMap(id => {
    const sourceIds = references.get(id)
    if (!sourceIds || id.startsWith('next-') !== next) throw new Error(`Unknown or out-of-section evidence reference: ${id}`)
    return sourceIds
  }))]
  return { ...brief,
    themes: brief.themes.map(theme => ({ ...theme, evidenceIds: resolve(theme.evidenceIds, false) })),
    whatMoved: brief.whatMoved.map(bullet => ({ ...bullet, evidenceIds: resolve(bullet.evidenceIds, false) })),
    goingIntoNextWeek: brief.goingIntoNextWeek.map(bullet => ({ ...bullet, evidenceIds: resolve(bullet.evidenceIds, true) })) }
}

export function annotateActivityAnalysis(analysis: ActivityAnalysis, brief: WeeklyImpactBrief): ActivityAnalysis {
  const themes = new Set(brief.themes.flatMap(theme => theme.evidenceIds))
  const moved = new Set(brief.whatMoved.flatMap(bullet => bullet.evidenceIds))
  const todos = [...analysis.clusters.flatMap(cluster => cluster.completedTodos), ...analysis.unclusteredTodos]
  return { ...analysis,
    clusters: analysis.clusters.map(cluster => ({ ...cluster, usedInThemes: cluster.evidenceIds.some(id => themes.has(id)), usedInWhatMoved: cluster.evidenceIds.some(id => moved.has(id)) })),
    todoCitations: { themes: todos.filter(todo => themes.has(todo.id)).length, whatMoved: todos.filter(todo => moved.has(todo.id)).length } }
}
