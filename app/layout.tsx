import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Killer Kockpit',
  description: 'Killer Kebab management operating system',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  )
}
