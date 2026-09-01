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
 * Throws if NEXT_PUBLIC_APP_URL is not set — treated as a fatal
 * misconfiguration that Next.js surfaces as an HTTP 500.
 */
export function getAppOrigin(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL
  if (!url) {
    throw new Error(
      '[app-url] NEXT_PUBLIC_APP_URL is not set — cannot construct canonical redirect URLs',
    )
  }
  return url.replace(/\/$/, '')
}
