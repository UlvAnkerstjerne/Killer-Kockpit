import type { SupabaseClient } from '@supabase/supabase-js'
import type { KockpitActionsActor } from '@/lib/kockpit-actions/repository'
import { resolveKockpitMcpActor } from './access'
import { handleKockpitMcpRequest } from './server'

export type AuthenticatedMcpContext = {
  jwtClaims: { sub: string; client_id?: unknown; [key: string]: unknown } | null
  userClaims: { id: string } | null
  supabaseAdmin: SupabaseClient
}

type McpDependencies = {
  resolveActor: (client: SupabaseClient, authUserId: string) => Promise<KockpitActionsActor | null>
  handleRequest: (request: Request, actor: KockpitActionsActor) => Promise<Response>
}

export async function handleAuthenticatedMcpRequest(
  request: Request,
  context: AuthenticatedMcpContext,
  dependencies: McpDependencies = {
    resolveActor: resolveKockpitMcpActor,
    handleRequest: handleKockpitMcpRequest,
  },
): Promise<Response> {
  if (new URL(request.url).pathname !== '/api/mcp') {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  // OAuth access tokens contain client_id. Requiring it prevents a normal
  // Kockpit browser-session JWT from being reused against the MCP endpoint.
  if (typeof context.jwtClaims?.client_id !== 'string' || !context.jwtClaims.client_id) {
    return Response.json({ error: 'oauth_token_required' }, { status: 401 })
  }

  const authUserId = context.userClaims?.id
  if (!authUserId) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const actor = await dependencies.resolveActor(context.supabaseAdmin, authUserId)
  if (!actor) return Response.json({ error: 'forbidden' }, { status: 403 })

  return dependencies.handleRequest(request, actor)
}
