import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { collectWeeklyImpactEvidence } from './collect-evidence'
import { buildWeeklyImpactPrompt, WEEKLY_IMPACT_PROMPT_VERSION, WEEKLY_IMPACT_SYSTEM_PROMPT } from './prompt'
import { WeeklyImpactBriefSchema, type WeeklyImpactPreview } from './types'
import { annotateActivityAnalysis, buildActivityAnalysis, buildSynthesisInput, resolveBriefReferences } from './activity-clusters'
import { renderWeeklyImpactEmail } from './render-email'
import { validateWeeklyImpactBrief } from './validate-brief'

export async function generateWeeklyImpactPreview(userId: string, selectedDate: string): Promise<WeeklyImpactPreview> {
  const evidence = await collectWeeklyImpactEvidence(userId, selectedDate)
  const activityAnalysis = buildActivityAnalysis(evidence)
  const { references } = buildSynthesisInput(evidence, activityAnalysis)
  const model = process.env.BRIEF_AI_MODEL ?? process.env.MEETING_AI_MODEL
  if (!model) throw new Error('Weekly Impact AI model is not configured.')
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('AI provider is not configured.')
  // One synthesis call. No editorial passes, automatic retries or reasoning overrides.
  const client = new Anthropic({ apiKey, maxRetries: 0 })
  const response = await client.messages.parse({
    model, max_tokens: 3000, system: WEEKLY_IMPACT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildWeeklyImpactPrompt(evidence, activityAnalysis) }],
    output_config: { format: zodOutputFormat(WeeklyImpactBriefSchema) },
  })
  if (!response.parsed_output) throw new Error(`No valid structured output (${response.stop_reason ?? 'unknown'})`)
  const brief = resolveBriefReferences(response.parsed_output, references)
  validateWeeklyImpactBrief(brief, evidence)
  return { evidence, activityAnalysis: annotateActivityAnalysis(activityAnalysis, brief), brief,
    ...renderWeeklyImpactEmail(evidence, brief), model, promptVersion: WEEKLY_IMPACT_PROMPT_VERSION }
}
