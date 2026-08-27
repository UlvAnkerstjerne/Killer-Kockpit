import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import LoginForm from './LoginForm'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Already authenticated — redirect to app
  if (user) redirect('/')

  const params = await searchParams

  return (
    <div className="min-h-screen bg-kk-bg flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-10 text-center">
          <h1 className="text-3xl font-black tracking-tight text-kk-ink">
            Killer Kockpit
          </h1>
          <p className="text-sm font-bold tracking-widest uppercase text-kk-muted mt-1">
            Killer Kebab OS
          </p>
        </div>

        <div className="bg-white border border-kk-line rounded-2xl p-8">
          <p className="text-sm text-kk-muted mb-6 text-center">
            Sign in with your Killer Kebab Google account.
          </p>

          {params.error && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              {params.error === 'access_denied'
                ? 'Access denied. Your account must be approved by an administrator.'
                : params.error === 'inactive'
                ? 'Your account has been deactivated. Contact an administrator.'
                : params.error === 'provisioning_failed'
                ? 'Sign-in failed during account setup. Please contact an administrator.'
                : 'An error occurred. Please try again.'}
            </div>
          )}

          {params.message && (
            <div className="mb-4 p-3 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-700">
              {params.message}
            </div>
          )}

          <LoginForm />
        </div>

        <p className="text-xs text-kk-muted text-center mt-6">
          Internal use only. Authorised Killer Kebab personnel only.
        </p>
      </div>
    </div>
  )
}
