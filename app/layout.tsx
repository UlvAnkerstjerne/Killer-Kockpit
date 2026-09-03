import type { Metadata } from 'next'
import { Chelsea_Market } from 'next/font/google'
import './globals.css'

const chelseaMarket = Chelsea_Market({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-brand',
})

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
    <html lang="en" className={`${chelseaMarket.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  )
}
