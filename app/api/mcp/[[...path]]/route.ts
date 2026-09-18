import { fromSupabaseUrl, withOAuthProtectedResource, withSupabase } from '@supabase/server'
import { getAppOrigin } from '@/lib/app-url'
import { handleAuthenticatedMcpRequest } from '@/lib/mcp/route-handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function createHandler() {
  const supabaseUrl = requiredEnv('NEXT_PUBLIC_SUPABASE_URL')
  const resourceServer = `${getAppOrigin()}/api/mcp`

  return withOAuthProtectedResource({
    resourceServer,
    authorizationServer: fromSupabaseUrl(supabaseUrl),
    errors: { detailed: false },
  }, withSupabase({
    auth: 'user',
    audience: 'authenticated',
    issuer: `${supabaseUrl}/auth/v1`,
    errors: { detailed: false },
    env: {
      url: supabaseUrl,
      publishableKeys: { default: requiredEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY') },
      secretKeys: { default: requiredEnv('SUPABASE_SECRET_KEY') },
      jwks: new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
    },
  }, async (request, context) => handleAuthenticatedMcpRequest(request, context)))
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

async function route(request: Request): Promise<Response> {
  return createHandler()(request)
}

export const GET = route
export const POST = route
export const DELETE = route
export const OPTIONS = route
