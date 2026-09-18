import { describe, expect, it, vi } from 'vitest'
import {
  loadSelectedStoreData,
  selectAssignedStore,
  type AssignedStore,
} from '@/lib/store/dashboard-selection'

const vesterbro: AssignedStore = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Killer Kebab Vesterbro',
  short_name: 'Vesterbro',
}

const fisketorvet: AssignedStore = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Killer Kebab Fisketorvet',
  short_name: 'Fisketorvet',
}

function loaders() {
  return {
    fetchTodos: vi.fn(async (userId: string) => [`todo:${userId}`]),
    fetchTasks: vi.fn(async (userId: string) => [`task:${userId}`]),
    fetchLatestAudit: vi.fn(async (locationId: string) => `audit:${locationId}`),
    fetchLatestDiner: vi.fn(async (locationId: string) => `diner:${locationId}`),
  }
}

describe('Store Manager location selection', () => {
  it('returns the safe no-store state for zero active locations', () => {
    expect(selectAssignedStore([], null)).toEqual({ state: 'no_store', locations: [] })
  })

  it('selects a sole active location without requiring a URL parameter', () => {
    expect(selectAssignedStore([vesterbro], null)).toMatchObject({
      state: 'selected',
      location: vesterbro,
    })
  })

  it('requires an explicit selection for two active locations', () => {
    expect(selectAssignedStore([vesterbro, fisketorvet], null)).toEqual({
      state: 'selection_required',
      locations: [vesterbro, fisketorvet],
      invalidRequest: false,
    })
  })

  it('accepts an assigned requested location', () => {
    expect(selectAssignedStore([vesterbro, fisketorvet], fisketorvet.id)).toMatchObject({
      state: 'selected',
      location: fisketorvet,
    })
  })

  it('rejects an unassigned requested location without selecting a store', () => {
    expect(selectAssignedStore([vesterbro, fisketorvet], 'unassigned-location')).toEqual({
      state: 'selection_required',
      locations: [vesterbro, fisketorvet],
      invalidRequest: true,
    })
  })

  it.each([
    { label: 'zero locations', selection: selectAssignedStore([], null) },
    { label: 'multi-store before selection', selection: selectAssignedStore([vesterbro, fisketorvet], null) },
    { label: 'invalid location', selection: selectAssignedStore([vesterbro, fisketorvet], 'not-assigned') },
  ])('runs no dashboard queries for $label', async ({ selection }) => {
    const dataLoaders = loaders()

    await expect(loadSelectedStoreData(selection, 'user-1', dataLoaders)).resolves.toBeNull()
    expect(dataLoaders.fetchTodos).not.toHaveBeenCalled()
    expect(dataLoaders.fetchTasks).not.toHaveBeenCalled()
    expect(dataLoaders.fetchLatestAudit).not.toHaveBeenCalled()
    expect(dataLoaders.fetchLatestDiner).not.toHaveBeenCalled()
  })

  it('keeps personal reads user-scoped and store reads location-scoped', async () => {
    const dataLoaders = loaders()
    const selection = selectAssignedStore([vesterbro, fisketorvet], vesterbro.id)

    await loadSelectedStoreData(selection, 'user-1', dataLoaders)

    expect(dataLoaders.fetchTodos).toHaveBeenCalledWith('user-1')
    expect(dataLoaders.fetchTasks).toHaveBeenCalledWith('user-1')
    expect(dataLoaders.fetchLatestAudit).toHaveBeenCalledWith(vesterbro.id)
    expect(dataLoaders.fetchLatestDiner).toHaveBeenCalledWith(vesterbro.id)
  })

  it('changes only the store scope when switching locations', async () => {
    const firstLoaders = loaders()
    const secondLoaders = loaders()

    await loadSelectedStoreData(
      selectAssignedStore([vesterbro, fisketorvet], vesterbro.id),
      'user-1',
      firstLoaders,
    )
    await loadSelectedStoreData(
      selectAssignedStore([vesterbro, fisketorvet], fisketorvet.id),
      'user-1',
      secondLoaders,
    )

    expect(firstLoaders.fetchLatestAudit).toHaveBeenCalledWith(vesterbro.id)
    expect(firstLoaders.fetchLatestDiner).toHaveBeenCalledWith(vesterbro.id)
    expect(secondLoaders.fetchLatestAudit).toHaveBeenCalledWith(fisketorvet.id)
    expect(secondLoaders.fetchLatestDiner).toHaveBeenCalledWith(fisketorvet.id)
    expect(secondLoaders.fetchTodos).toHaveBeenCalledWith('user-1')
    expect(secondLoaders.fetchTasks).toHaveBeenCalledWith('user-1')
  })
})
