/**
 * POST /api/gbp/publish
 *
 * Receives a multipart form with an image file, uploads it to Supabase Storage
 * (gbp-media bucket, public), and returns ONLY the trusted storage path.
 *
 * The browser never receives or controls the public URL or MIME type —
 * those are resolved server-side by the publish action from the storage object.
 *
 * Storage path is user-bound: posts/{userId}/{uuid}.{ext}
 * The publish action verifies the authenticated user owns the path.
 *
 * Security:
 *   - Authenticated users only (getCurrentUser)
 *   - Requires marketing access + content_manage permission (or SUPER_ADMIN)
 *   - Image type and size validated server-side
 *   - Storage path is server-generated (caller cannot choose it)
 *   - Service-role key never sent to the browser
 */

import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing, hasMarketingPermission } from '@/lib/permissions'
import { getUserMarketingPermissions } from '@/lib/actions/marketing/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import crypto from 'crypto'

const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10 MB
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export async function POST(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }
  if (!canAccessMarketing(user.role, user.marketing_access)) {
    return NextResponse.json({ error: 'Marketing access required.' }, { status: 403 })
  }
  const permissions = await getUserMarketingPermissions(user.id)
  if (!hasMarketingPermission(user.role, permissions, 'content_manage')) {
    return NextResponse.json({ error: 'content_manage permission required.' }, { status: 403 })
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data.' }, { status: 400 })
  }

  const file = formData.get('image')
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'Missing image file.' }, { status: 400 })
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: 'Image must be JPEG, PNG, or WebP.' }, { status: 400 })
  }

  if (file.size > MAX_IMAGE_SIZE) {
    return NextResponse.json({ error: 'Image must be under 10 MB.' }, { status: 400 })
  }

  const ext = file.type.split('/')[1] === 'jpeg' ? 'jpg' : file.type.split('/')[1]
  const fileId = crypto.randomUUID()
  const storagePath = `posts/${user.id}/${fileId}.${ext}`

  const buffer = Buffer.from(await file.arrayBuffer())

  const db = createServiceClient()
  const { error: uploadError } = await db.storage
    .from('gbp-media')
    .upload(storagePath, buffer, {
      contentType: file.type,
      upsert: false,
    })

  if (uploadError) {
    console.error('[api/gbp/publish] Upload failed:', uploadError.message)
    return NextResponse.json({ error: 'Image upload failed. Please retry.' }, { status: 500 })
  }

  // Only return the trusted storage path — the server action resolves URL and MIME.
  return NextResponse.json({ storagePath })
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
