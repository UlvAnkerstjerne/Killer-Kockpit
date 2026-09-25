export const BUSYNESS_OPTIONS = ['Full rush', 'Busy', 'Chill', 'Slow', 'Dead'] as const
export type Busyness = typeof BUSYNESS_OPTIONS[number]
