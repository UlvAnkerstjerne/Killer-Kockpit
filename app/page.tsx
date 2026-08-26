import { redirect } from 'next/navigation'

// Root redirects to Today — the default landing screen.
export default function RootPage() {
  redirect('/today')
}
