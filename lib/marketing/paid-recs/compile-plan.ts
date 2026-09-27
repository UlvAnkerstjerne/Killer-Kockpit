import { PaidRecActionIntentSchema, PaidRecExecutionPlanSchema, type PaidRecExecutionPlan } from './types'
import { MAX_AUTOMATED_BUDGET_CHANGE } from './guardrails'

export type SyncedTarget = {
  platform: 'meta' | 'google'; campaignId: string; accountId: string; status: string; currency: string
  dailyBudget?: number | null; adSetId?: string; campaignBudgetResourceName?: string; sharedBudget?: boolean
}

/**
 * Optional configured-account verification.
 * When provided, the compiler will reject plans whose synced target
 * does not belong to the configured advertising account.
 */
export interface ConfiguredAccounts {
  metaAdAccountId?: string   // e.g. 'act_123456'
  googleCustomerId?: string  // e.g. '8582465933'
}

export function compileExecutionPlan(
  intentInput: unknown,
  target: SyncedTarget,
  configuredAccounts?: ConfiguredAccounts,
): { ok: true; plan: PaidRecExecutionPlan } | { ok: false; reason: string } {
  const parsed = PaidRecActionIntentSchema.safeParse(intentInput)
  if (!parsed.success) return { ok: false, reason: 'AI action intent failed validation.' }
  const intent = parsed.data

  // Ownership verification: synced target must belong to the configured ad account.
  // For Meta: checked when metaAdAccountId is available.
  // For Google mutation intents: googleCustomerId is REQUIRED — fail closed if missing.
  const isGoogleMutation = target.platform === 'google'
    && intent.action_type !== 'monitor_only'
    && intent.action_type !== 'run_tracking_diagnostic'
    && intent.action_type !== 'create_task'

  if (configuredAccounts?.metaAdAccountId && target.platform === 'meta') {
    if (target.accountId !== configuredAccounts.metaAdAccountId) {
      return { ok: false, reason: 'Target campaign does not belong to the configured Meta ad account.' }
    }
  }

  if (isGoogleMutation) {
    const configuredId = configuredAccounts?.googleCustomerId
    if (!configuredId) {
      return { ok: false, reason: 'Google Ads customer ID is not configured. Cannot verify account ownership.' }
    }
    const normalizedTarget = target.accountId.replace(/-/g, '')
    const normalizedConfigured = configuredId.replace(/-/g, '')
    if (normalizedTarget !== normalizedConfigured) {
      return { ok: false, reason: 'Target campaign does not belong to the configured Google Ads customer.' }
    }
  }

  if (intent.target_id !== target.campaignId && intent.target_id !== target.adSetId) return { ok: false, reason: 'AI target does not match a synced platform ID.' }
  let candidate: unknown
  if (intent.action_type === 'monitor_only' || intent.action_type === 'run_tracking_diagnostic') candidate = { action_type: intent.action_type, platform: target.platform, campaign_id: target.campaignId }
  else if (intent.action_type === 'create_task') candidate = { action_type: 'create_task', platform: target.platform, campaign_id: target.campaignId, reason: intent.reason }
  else if (intent.action_type === 'pause_campaign' || intent.action_type === 'resume_campaign') {
    const pause = intent.action_type === 'pause_campaign'
    candidate = target.platform === 'meta'
      ? { action_type: pause ? 'meta_pause_campaign' : 'meta_resume_campaign', platform: 'meta', target_type: 'campaign', target_id: target.campaignId, ad_account_id: target.accountId, expected_current_status: pause ? 'ACTIVE' : 'PAUSED' }
      : { action_type: pause ? 'google_pause_campaign' : 'google_resume_campaign', platform: 'google', customer_id: target.accountId, campaign_id: target.campaignId, expected_current_status: pause ? 'ENABLED' : 'PAUSED' }
  } else if (intent.action_type === 'set_daily_budget') {
    if (!target.dailyBudget || target.dailyBudget <= 0) return { ok: false, reason: 'Synced target has no daily budget.' }
    // Google: reject shared budgets at compile time (guardrails also check at runtime)
    if (target.platform === 'google' && target.sharedBudget) {
      return { ok: false, reason: 'Shared budgets require manual review.' }
    }
    // Google: reject when budget resource name is missing (cannot target the mutation)
    if (target.platform === 'google' && !target.campaignBudgetResourceName) {
      return { ok: false, reason: 'Google campaign budget resource name is unavailable.' }
    }
    // Reject budget changes exceeding the 25% automation limit at compile time
    if (Math.abs(intent.target_daily_budget / target.dailyBudget - 1) > MAX_AUTOMATED_BUDGET_CHANGE + Number.EPSILON) {
      return { ok: false, reason: `Budget change exceeds the ${MAX_AUTOMATED_BUDGET_CHANGE * 100}% automation limit.` }
    }
    // Reject currency mismatch (AI must not supply currency; server resolves it)
    if (!target.currency || !/^[A-Z]{3}$/.test(target.currency)) {
      return { ok: false, reason: 'Target currency is missing or invalid.' }
    }
    if (target.platform === 'meta') candidate = { action_type: intent.target_type === 'adset' ? 'meta_set_adset_budget' : 'meta_set_campaign_budget', platform: 'meta', target_type: intent.target_type, target_id: intent.target_type === 'adset' ? target.adSetId : target.campaignId, ...(intent.target_type === 'adset' ? { campaign_id: target.campaignId } : {}), ad_account_id: target.accountId, currency: target.currency, current_daily_budget: target.dailyBudget, target_daily_budget: intent.target_daily_budget }
    else candidate = { action_type: 'google_set_campaign_budget', platform: 'google', customer_id: target.accountId, campaign_id: target.campaignId, campaign_budget_resource_name: target.campaignBudgetResourceName, shared_budget: false, currency: target.currency, current_daily_budget: target.dailyBudget, target_daily_budget: intent.target_daily_budget }
  } else return { ok: false, reason: 'Unsupported action intent.' }
  const plan = PaidRecExecutionPlanSchema.safeParse(candidate)
  return plan.success ? { ok: true, plan: plan.data } : { ok: false, reason: 'Intent cannot be resolved to a safe, unambiguous target.' }
}
