import type { SupabaseClient } from '@supabase/supabase-js'
import type { KockpitActionsActor } from '@/lib/kockpit-actions/repository'

export const KOCKPIT_MCP_ALLOWED_EMAILS = new Set(['ulv@killerkebab.com'])

export function isKockpitMcpAllowedEmail(email: string | null | undefined): boolean {
  return Boolean(email && KOCKPIT_MCP_ALLOWED_EMAILS.has(email.toLowerCase()))
}

export async function resolveKockpitMcpActor(
  client: SupabaseClient,
  authUserId: string,
): Promise<KockpitActionsActor | null> {
  const { data, error } = await client
    .from('app_users')
    .select('id, email, role')
    .eq('auth_user_id', authUserId)
    .eq('active', true)
    .maybeSingle()

  if (error || !data || !isKockpitMcpAllowedEmail(data.email)) return null
  return data as KockpitActionsActor
}
