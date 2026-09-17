import { z } from 'zod'

export type ImpactEvidenceKind =
  | 'task'
  | 'project'
  | 'meeting'
  | 'decision'
  | 'waiting_on'
  | 'update'
  | 'todo'

export interface ImpactEvidenceItem {
  id: string
  kind: ImpactEvidenceKind
  title: string
  detail: string | null
  occurredAt: string
  projectId: string | null
  projectTitle: string | null
  status: string | null
  url: string
  attribution: string
}

export interface WeeklyImpactEvidence {
  user: { id: string; name: string; email: string }
  week: {
    startDate: string
    endDate: string
    startIso: string
    endExclusiveIso: string
    displayRange: string
  }
  completedTasks: ImpactEvidenceItem[]
  completedTodos: ImpactEvidenceItem[]
  movedProjects: ImpactEvidenceItem[]
  meetings: ImpactEvidenceItem[]
  decisions: ImpactEvidenceItem[]
  resolvedWaitingOns: ImpactEvidenceItem[]
  authoredUpdates: ImpactEvidenceItem[]
  nextWeek: ImpactEvidenceItem[]
  counts: {
    tasksCompleted: number
    todosCompleted: number
    projectsMoved: number
    meetings: number
    decisions: number
    waitingOnsResolved: number
    updatesShared: number
  }
}

const EvidenceBulletSchema = z.object({
  text: z.string().trim().min(3).max(160),
  evidenceIds: z.array(z.string()).min(1).max(8),
})

const ThemeSchema = z.object({
  heading: z.string().trim().min(3).max(60).describe('A short, evidence-derived theme about what the work amounted to.'),
  synthesis: z.string().trim().min(12).max(450).describe('Two concise sentences, preferably 30–35 words total. Interpret the shared pattern of work and its expected benefit. Not a recap of completed tasks: leave individual deliverables, tool names and locations to whatMoved. Use should or appears to for unmeasured effects. Never infer technical integration from a shared project.'),
  evidenceIds: z.array(z.string()).min(1).max(12),
})

export const WeeklyImpactBriefSchema = z.object({
  openingSynthesis: z.string().trim().min(20).max(500).describe('Two concise executive-summary sentences, about 40–45 words. Overall character of the week, without task titles or a list of examples.'),
  themes: z.array(ThemeSchema).max(3).describe('Prefer two distinct, coherent themes; do not force unrelated records into them.'),
  whatMoved: z.array(EvidenceBulletSchema).max(5).describe('Up to five short factual bullets, at most 14 words each. Group related work without transferring a detail from one record to another.'),
  goingIntoNextWeek: z.array(EvidenceBulletSchema).max(4).describe('Up to four open commitments, at most 16 words each, using only nextWeek evidence. Include exact short due dates. No advice or invented responsibilities.'),
}).strict()

export type WeeklyImpactBrief = z.infer<typeof WeeklyImpactBriefSchema>

export interface ActivityMention {
  kind: 'person' | 'location'
  name: string
  evidenceId: string
  quote: string
}

export interface ActivityCluster {
  id: string
  heading: string
  rationale: string
  evidenceIds: string[]
  completedTodoCount: number
  completedTodos: Array<{ id: string; title: string }>
  relatedTasks: Array<{ id: string; title: string }>
  relatedProjects: Array<{ id: string; title: string | null }>
  mentions: ActivityMention[]
  usedInThemes: boolean
  usedInWhatMoved: boolean
}

export interface ActivityAnalysis {
  clusters: ActivityCluster[]
  unclusteredTodos: Array<{ id: string; title: string; reason: string }>
  totalCompletedTodos: number
  clusteredCompletedTodos: number
  todoCitations: { themes: number; whatMoved: number }
}

export interface WeeklyImpactPreview {
  evidence: WeeklyImpactEvidence
  activityAnalysis: ActivityAnalysis
  brief: WeeklyImpactBrief
  subject: string
  html: string
  text: string
  model: string
  promptVersion: string
}
