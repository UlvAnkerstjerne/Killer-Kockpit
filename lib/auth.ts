import { createClient } from './supabase/server'
import type { AppUser } from './types'

// Fetches the current authenticated user from app_users.
// Returns null if the user has no session, is not in app_users, or is inactive.
// This is the single authoritative source of user identity for server components.
export async function getCurrentUser(): Promise<AppUser | null> {
  const supabase = await createClient()

  const {
    data: { user: authUser },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !authUser) return null

  const { data: appUser, error: userError } = await supabase
    .from('app_users')
    .select('*')
    .eq('auth_user_id', authUser.id)
    .eq('active', true)
    .single()

  if (userError || !appUser) return null

  return appUser as AppUser
}

// Fetches all active users — used for owner/assignee dropdowns.
export async function getActiveUsers(): Promise<Pick<AppUser, 'id' | 'display_name' | 'email'>[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('app_users')
    .select('id, display_name, email')
    .eq('active', true)
    .order('display_name')

  if (error || !data) return []
  return data
}
