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
 *
 * Retries once on validation failure (Anthropic structured outputs do not enforce
 * maxLength at the API level — Zod validation catches oversized fields post-parse).
 */
/** Truncate a string at the last word boundary within maxLen. */
function clamp(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  const truncated = s.slice(0, maxLen)
  const lastSpace = truncated.lastIndexOf(' ')
  return (lastSpace > maxLen * 0.6 ? truncated.slice(0, lastSpace) : truncated) + '…'
}

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

  const MAX_ATTEMPTS = 2
  let lastError = ''

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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

      // Trim and clamp all string fields to schema limits.
      // Anthropic structured outputs do not enforce maxLength at the API level,
      // so the model can exceed limits. Clamping here prevents validation
      // failures that would otherwise kill the entire brief.
      const output: MorningBriefAIOutput = {
        overall_reason:      clamp(parsed.overall_reason.trim(), 200),
        ai_summary:          clamp(parsed.ai_summary.trim(), 200),
        paid_assessment:     clamp(parsed.paid_assessment.trim(), 600),
        organic_assessment:  clamp(parsed.organic_assessment.trim(), 600),
        gbp_assessment:      parsed.gbp_assessment ? clamp(parsed.gbp_assessment.trim(), 300) : null,
        observations:        parsed.observations.map((o) => ({
          signal_id:          o.signal_id.trim(),
          observation:        clamp(o.observation.trim(), 150),
          evidence:           clamp(o.evidence.trim(), 250),
          interpretation:     clamp(o.interpretation.trim(), 600),
          recommended_action: clamp(o.recommended_action.trim(), 150),
          creative_start:     o.creative_start ? clamp(o.creative_start.trim(), 300) : null,
          driver_id:          o.driver_id?.trim() ?? null,
        })),
      }

      return {
        ok: true,
        output,
        model,
        promptVersion: BRIEF_PROMPT_VERSION,
        durationMs: Date.now() - startMs,
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Unknown error'
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[ai/morning-brief] Attempt ${attempt} failed (${lastError}), retrying…`)
      }
    }
  }

  console.error('[ai/morning-brief] All attempts failed:', lastError)
  return {
    ok: false,
    error: 'Morning Brief generation failed. The previous brief will be shown.',
    errorDetail: lastError,
  }
}
