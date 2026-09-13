import { redirect } from 'next/navigation'
import { getCurrentUser }          from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import BrainClient from './BrainClient'

export const metadata = { title: 'Kockpit Brain' }

export default async function BrainPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!canAccessManagementView(user.role)) redirect('/')

  return <BrainClient />
}
