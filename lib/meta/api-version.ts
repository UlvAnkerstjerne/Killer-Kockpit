/**
 * lib/meta/api-version.ts
 *
 * Single source of truth for the Meta Graph API version.
 * Bump this constant to upgrade the entire Meta integration at once.
 *
 * Current: v26.0 (released mid-2026, current as of August 2026).
 */

export const META_GRAPH_API_VERSION = 'v26.0' as const
export const META_GRAPH_BASE_URL    = `https://graph.facebook.com/${META_GRAPH_API_VERSION}` as const
