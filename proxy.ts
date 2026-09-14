import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    // Run on all routes except static files, Next.js internals, the Railway healthcheck,
    // and server-to-server cron API routes (which use CRON_SECRET bearer auth, not sessions)
    '/((?!_next/static|_next/image|favicon.ico|api/health|api/meta/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
