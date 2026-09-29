/**
 * lib/app-url.ts
 *
 * Returns the canonical application origin (scheme + host, no trailing slash).
 *
 * Server-side route handlers must use this instead of deriving an origin from
 * request.url or request.nextUrl.origin.  Behind Railway's reverse proxy those
 * values carry the internal localhost:8080 address rather than the public domain
 * (kockpit.killerkebab.com in production, localhost:3001 locally).
 *
 * In local development (NODE_ENV=development), NEXT_PUBLIC_APP_URL is ignored
 * in favour of the dev server's actual origin so that OAuth callbacks return to
 * localhost instead of production.
 *
 * Throws if NEXT_PUBLIC_APP_URL is not set in production — treated as a fatal
 * misconfiguration that Next.js surfaces as an HTTP 500.
 */
export function getAppOrigin(): string {
  if (process.env.NODE_ENV === 'development') {
    const port = process.env.PORT || '3001'
    return `http://localhost:${port}`
  }
  const url = process.env.NEXT_PUBLIC_APP_URL
  if (!url) {
    throw new Error(
      '[app-url] NEXT_PUBLIC_APP_URL is not set — cannot construct canonical redirect URLs',
    )
  }
  return url.replace(/\/$/, '')
}
