import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { isKockpitMcpAllowedEmail } from '@/lib/mcp/access'

export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string }>
}) {
  const { authorization_id: authorizationId } = await searchParams
  if (!authorizationId) return <ConsentError message="Missing OAuth authorization request." />

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    const next = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`
    redirect(`/login?next=${encodeURIComponent(next)}`)
  }

  const appUser = await getCurrentUser()
  if (!appUser || !isKockpitMcpAllowedEmail(appUser.email)) {
    return <ConsentError message="This Kockpit account is not enabled for ChatGPT access." />
  }

  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId)
  if (error || !data) return <ConsentError message="This OAuth authorization request is invalid or expired." />
  if ('redirect_url' in data) redirect(data.redirect_url)

  const scopes = data.scope.split(' ').filter(Boolean)
  return (
    <main className="min-h-screen bg-kk-bg flex items-center justify-center p-6">
      <section className="w-full max-w-lg rounded-2xl border border-kk-line bg-white p-8">
        <p className="text-xs font-bold uppercase tracking-widest text-kk-muted">Killer Kockpit</p>
        <h1 className="mt-2 text-2xl font-black text-kk-ink">Connect {data.client.name || 'ChatGPT'}?</h1>
        <p className="mt-4 text-sm leading-6 text-kk-muted">
          This connection can create personal To-Dos and Tasks in Kockpit as {appUser.display_name}.
          It cannot read Kockpit data, edit, complete, or delete records, or access Brain or GBP.
        </p>

        <div className="mt-6 rounded-xl border border-kk-line bg-kk-soft p-4 text-sm text-kk-ink">
          <p><strong>Account:</strong> {appUser.email}</p>
          {scopes.length > 0 && <p className="mt-2"><strong>OAuth scopes:</strong> {scopes.join(', ')}</p>}
        </div>

        <form action="/api/oauth/consent" method="post" className="mt-8 flex gap-3">
          <input type="hidden" name="authorization_id" value={data.authorization_id} />
          <button name="decision" value="approve" className="flex-1 rounded-xl bg-kk-ink px-4 py-3 text-sm font-bold text-white">
            Allow creation
          </button>
          <button name="decision" value="deny" className="rounded-xl border border-kk-line px-4 py-3 text-sm font-bold text-kk-ink">
            Cancel
          </button>
        </form>
      </section>
    </main>
  )
}

function ConsentError({ message }: { message: string }) {
  return (
    <main className="min-h-screen bg-kk-bg flex items-center justify-center p-6">
      <section className="w-full max-w-lg rounded-2xl border border-kk-line bg-white p-8">
        <h1 className="text-2xl font-black text-kk-ink">Connection unavailable</h1>
        <p className="mt-4 text-sm text-kk-muted">{message}</p>
      </section>
    </main>
  )
}
