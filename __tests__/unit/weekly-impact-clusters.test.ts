import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { annotateActivityAnalysis, buildActivityAnalysis, buildSynthesisInput, resolveBriefReferences } from '@/lib/weekly-impact/activity-clusters'
import type { ImpactEvidenceItem, WeeklyImpactEvidence } from '@/lib/weekly-impact/types'
import { buildWeekWindow } from '@/lib/weekly-impact/week'
import ActivityClusterInspector from '@/app/(app)/settings/weekly-impact/ActivityClusterInspector'

const item = (id: string, kind: ImpactEvidenceItem['kind'], title: string): ImpactEvidenceItem => ({ id, kind, title, detail: null, occurredAt: '2026-09-08T10:00:00Z', projectId: null, projectTitle: null, status: 'done', url: '/todos', attribution: 'Recorded completion' })
const fixture = (): WeeklyImpactEvidence => ({
  user: { id: 'user-1', name: 'Test', email: 'test@example.com' }, week: buildWeekWindow('2026-09-07'),
  completedTodos: [item('todo:1', 'todo', 'Tjek Support'), item('todo:2', 'todo', 'Tjek Support'), item('todo:3', 'todo', 'Automatisk emailafsending AUDIT'), item('todo:4', 'todo', 'sæt up auto email mystery'), item('todo:5', 'todo', 'Sort out the thing')],
  completedTasks: [item('task:1', 'task', 'Audit i Kockpit'), item('task:2', 'task', 'Mystery Diner i Kockpit')],
  movedProjects: [], meetings: [], decisions: [], resolvedWaitingOns: [], authoredUpdates: [], nextWeek: [item('todo:open', 'todo', 'Review next rota')],
  counts: { tasksCompleted: 2, todosCompleted: 5, projectsMoved: 0, meetings: 0, decisions: 0, waitingOnsResolved: 0, updatesShared: 0 },
})

describe('deterministic To-Do clusters', () => {
  it('groups repeated subjects and related deliverables before AI, with exact counts', () => {
    const pack = fixture(), original = structuredClone(pack)
    const analysis = buildActivityAnalysis(pack)
    expect(analysis.clusters.map(cluster => [cluster.heading, cluster.completedTodoCount])).toEqual([['Email', 2], ['Support', 2]])
    expect(analysis.clusters[0].relatedTasks).toHaveLength(2)
    expect(analysis).toMatchObject({ totalCompletedTodos: 5, clusteredCompletedTodos: 4, unclusteredTodos: [{ id: 'todo:5' }] })
    expect(buildActivityAnalysis(pack)).toEqual(analysis)
    expect(pack).toEqual(original)
  })
  it('does not double-count duplicate records or include open work', () => {
    const pack = fixture(); pack.completedTodos.push(pack.completedTodos[0])
    const analysis = buildActivityAnalysis(pack)
    expect(analysis.totalCompletedTodos).toBe(5)
    const ids = analysis.clusters.flatMap(cluster => cluster.evidenceIds)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain('todo:open')
  })
  it('retains ambiguous and QA To-Dos with a reason, without using QA as achievements', () => {
    const pack = fixture(); pack.completedTodos.push(item('todo:qa', 'todo', 'QA record — not operational'))
    const analysis = buildActivityAnalysis(pack)
    expect(analysis.unclusteredTodos.map(todo => todo.id)).toEqual(['todo:5', 'todo:qa'])
    expect(buildSynthesisInput(pack, analysis).input.unclusteredTodos).toHaveLength(1)
  })
  it('uses recorded project context without inventing entity links or grouping merely by ownership', () => {
    const pack = fixture()
    pack.completedTasks.forEach(task => { task.projectId = 'project-1'; task.projectTitle = 'Operations' })
    pack.completedTasks.push({ ...item('task:3', 'task', 'Prepare training handbook'), projectId: 'project-1', projectTitle: 'Operations' })
    const analysis = buildActivityAnalysis(pack)
    expect(analysis.clusters[0].relatedProjects).toEqual([{ id: 'project-1', title: 'Operations' }])
    expect(analysis.clusters.find(cluster => cluster.relatedTasks.some(task => task.id === 'task:3'))!.completedTodoCount).toBe(0)
    const input = buildSynthesisInput(pack, analysis).input
    expect(input.activityClusters[0]).toMatchObject({ completedTodoCount: 2, people: [], locations: [] })
  })
  it('resolves short AI references back to source IDs without AI bookkeeping', () => {
    const pack = fixture(), analysis = buildActivityAnalysis(pack)
    const { references } = buildSynthesisInput(pack, analysis)
    const brief = resolveBriefReferences({ openingSynthesis: 'Recorded work supports recurring operational follow-through.', themes: [{ heading: 'Follow-through', synthesis: 'Recurring work supported operational checks.', evidenceIds: ['cluster-1'] }], whatMoved: [{ text: 'Set up related email workflows.', evidenceIds: ['cluster-1'] }], goingIntoNextWeek: [{ text: 'Review the next rota.', evidenceIds: ['next-1'] }] }, references)
    expect(brief.whatMoved[0].evidenceIds).toEqual(analysis.clusters[0].evidenceIds)
    expect(brief.goingIntoNextWeek[0].evidenceIds).toEqual(['todo:open'])
    expect(annotateActivityAnalysis(analysis, brief).todoCitations).toEqual({ themes: 2, whatMoved: 2 })
    expect(() => resolveBriefReferences({ ...brief, whatMoved: [{ text: 'Wrong section', evidenceIds: ['next-1'] }] }, references)).toThrow()
  })
  it('keeps the management inspector with exact counts and source titles', () => {
    const html = renderToStaticMarkup(createElement(ActivityClusterInspector, { analysis: buildActivityAnalysis(fixture()) }))
    expect(html).toContain('5 completed To-Dos reviewed')
    expect(html).toContain('Tjek Support')
    expect(html).toContain('before the AI')
    expect(html).toContain('Unclustered To-Dos')
  })
})
