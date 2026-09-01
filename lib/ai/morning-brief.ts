/**
 * lib/ai/morning-brief.ts
 *
 * Anthropic API call for Morning Brief generation.
 *
 * Provider-agnostic interface: MorningBriefContext and MorningBriefAIResult types
 * are not Anthropic-specific. A different provider could be wired in by replacing
 * this implementation without changing callers.
 *
 * Runtime validation: uses zodOutputFormat + client.messages.parse to get
 * a Zod-validated structured response. Malformed AI responses are caught here
 * and returned as { ok: false } — the orchestrator then preserves the existing
 * good brief rather than replacing it with nothing.
 *
 * Security:
 *   The system prompt explicitly instructs the model that external data (campaign
 *   names, post captions) is untrusted. No user session or PII is sent.
 *
 * Environment variables:
 *   BRIEF_AI_MODEL   — Model ID (falls back to MEETING_AI_MODEL if absent)
 *   ANTHROPIC_API_KEY — Anthropic API key
 */

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { MorningBriefAIOutputSchema, type MorningBriefAIOutput } from '@/lib/marketing/brief/types'
import { MORNING_BRIEF_SYSTEM_PROMPT, BRIEF_PROMPT_VERSION } from '@/lib/marketing/brief/build-prompt'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MorningBriefAISuccess {
  ok: true
  output: MorningBriefAIOutput
  model: string
  promptVersion: string
  durationMs: number
}

export interface MorningBriefAIFailure {
  ok: false
  error: string          // user-safe message
  errorDetail?: string   // internal detail for logging/debugging (not shown to users)
}

export type MorningBriefAIResult = MorningBriefAISuccess | MorningBriefAIFailure

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Calls Claude with the pre-built prompt and returns a validated structured response.
 *
 * Uses zodOutputFormat for structured output — no fragile free-form text parsing.
 * Validation failures return { ok: false } so the orchestrator can preserve the
 * last good brief.
 */
export async function callMorningBriefAI(
  userMessage: string,
): Promise<MorningBriefAIResult> {
  const model = process.env.BRIEF_AI_MODEL ?? process.env.MEETING_AI_MODEL
  if (!model) {
    return {
      ok: false,
      error: 'Morning Brief AI model is not configured.',
      errorDetail: 'Set BRIEF_AI_MODEL or MEETING_AI_MODEL in environment variables.',
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return {
      ok: false,
      error: 'AI provider is not configured.',
      errorDetail: 'ANTHROPIC_API_KEY is not set.',
    }
  }

  const client = new Anthropic({ apiKey })
  const startMs = Date.now()

  try {
    const response = await client.messages.parse({
      model,
      max_tokens: 2048,
      system: MORNING_BRIEF_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      output_config: {
        format: zodOutputFormat(MorningBriefAIOutputSchema),
      },
    })

    const parsed = response.parsed_output

    if (!parsed) {
      const reason = response.stop_reason ?? 'unknown'
      return {
        ok: false,
        error: 'AI model did not return a valid response.',
        errorDetail: `stop_reason: ${reason}`,
      }
    }

    // Trim all string fields — Zod already validated structure
    const output: MorningBriefAIOutput = {
      overall_reason:      parsed.overall_reason.trim(),
      ai_summary:          parsed.ai_summary.trim(),
      paid_assessment:     parsed.paid_assessment.trim(),
      organic_assessment:  parsed.organic_assessment.trim(),
      gbp_assessment:      parsed.gbp_assessment?.trim() ?? null,
    }

    return {
      ok: true,
      output,
      model,
      promptVersion: BRIEF_PROMPT_VERSION,
      durationMs: Date.now() - startMs,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[ai/morning-brief] API call failed:', message)
    return {
      ok: false,
      error: 'Morning Brief generation failed. The previous brief will be shown.',
      errorDetail: message,
    }
  }
}
