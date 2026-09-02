import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import type { Todo } from '@/lib/types'
import TodoPageClient from './TodoPageClient'

export const dynamic = 'force-dynamic'

export default async function TodosPage() {
  const user = await getCurrentUser()
  if (!user) return null

  const supabase = await createClient()

  // Fetch all todos for this user. RLS enforces ownership; .eq is belt-and-suspenders.
  const { data } = await supabase
    .from('todos')
    .select('id, user_id, title, priority, created_at, updated_at, completed_at, cancelled_at')
    .eq('user_id', user.id)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(200)

  const todos = (data ?? []) as Todo[]

  const openTodos      = todos.filter(t => !t.completed_at && !t.cancelled_at)
  const completedTodos = todos
    .filter(t => !!t.completed_at)
    .sort((a, b) => new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime())
  const cancelledTodos = todos
    .filter(t => !!t.cancelled_at && !t.completed_at)
    .sort((a, b) => new Date(b.cancelled_at!).getTime() - new Date(a.cancelled_at!).getTime())

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">To-Dos</h1>
        <p className="text-sm text-kk-muted mt-0.5">Your personal to-do list.</p>
      </div>

      <TodoPageClient
        openTodos={openTodos}
        completedTodos={completedTodos}
        cancelledTodos={cancelledTodos}
      />
    </div>
  )
}
