export interface AssignedStore {
  id: string
  name: string
  short_name: string
}

export type StoreSelection =
  | { state: 'no_store'; locations: [] }
  | { state: 'selection_required'; locations: AssignedStore[]; invalidRequest: boolean }
  | { state: 'selected'; location: AssignedStore; locations: AssignedStore[] }

/**
 * Treats the requested location as an untrusted hint. A store is selected only
 * when it is present in the authenticated employee's active canonical stores.
 */
export function selectAssignedStore(
  locations: AssignedStore[],
  requestedLocationId: string | null,
): StoreSelection {
  if (locations.length === 0) {
    return { state: 'no_store', locations: [] }
  }

  if (requestedLocationId !== null) {
    const requested = locations.find(location => location.id === requestedLocationId)
    if (requested) {
      return { state: 'selected', location: requested, locations }
    }

    return { state: 'selection_required', locations, invalidRequest: true }
  }

  if (locations.length === 1) {
    return { state: 'selected', location: locations[0], locations }
  }

  return { state: 'selection_required', locations, invalidRequest: false }
}

interface StoreDashboardLoaders<TTodo, TTask, TAudit, TDiner> {
  fetchTodos: (userId: string) => Promise<TTodo>
  fetchTasks: (userId: string) => Promise<TTask>
  fetchLatestAudit: (locationId: string) => Promise<TAudit>
  fetchLatestDiner: (locationId: string) => Promise<TDiner>
}

/**
 * The only entry point for live dashboard reads. Non-selected states return
 * before invoking any loader; personal and store scopes are passed separately.
 */
export async function loadSelectedStoreData<TTodo, TTask, TAudit, TDiner>(
  selection: StoreSelection,
  userId: string,
  loaders: StoreDashboardLoaders<TTodo, TTask, TAudit, TDiner>,
): Promise<{
  todos: TTodo
  tasks: TTask
  latestAudit: TAudit
  latestDiner: TDiner
} | null> {
  if (selection.state !== 'selected') return null

  const [todos, tasks, latestAudit, latestDiner] = await Promise.all([
    loaders.fetchTodos(userId),
    loaders.fetchTasks(userId),
    loaders.fetchLatestAudit(selection.location.id),
    loaders.fetchLatestDiner(selection.location.id),
  ])

  return { todos, tasks, latestAudit, latestDiner }
}
