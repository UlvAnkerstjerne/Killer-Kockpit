/**
 * app/(diner)/layout.tsx
 *
 * Minimal layout for the public Mystery Diner route group.
 * Intentionally contains no Kockpit navigation, authentication,
 * or AppShell — diners have no Kockpit account.
 *
 * The root app/layout.tsx provides the HTML shell and global styles.
 */
export default function DinerLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
