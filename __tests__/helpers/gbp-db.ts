/** Small stateful PostgREST test double: verifies persisted checkpoints/data on reruns. */
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export function gbpDb() {
  const tables: Record<string, Row[]> = {}
  const failures: Record<string, number> = {}
  const writes: Array<{ table: string; operation: string; rows: Row[] }> = []
  let nextId = 1
  const from = (table: string) => {
    let operation = 'select', rows: Row[] = [], conflict = '', single = false
    let range: [number, number] | null = null
    const filters: Array<(row: Row) => boolean> = []
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query },
      is: (key: string, value: unknown) => { filters.push(row => (row[key] ?? null) === value); return query },
      in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return query },
      order: () => query,
      range: (start: number, end: number) => { range = [start, end]; return query },
      single: () => { single = true; return query },
      maybeSingle: () => { single = true; return query },
      insert: (data: Row | Row[]) => { operation = 'insert'; rows = Array.isArray(data) ? data : [data]; return query },
      upsert: (data: Row | Row[], options: { onConflict: string }) => { operation = 'upsert'; rows = Array.isArray(data) ? data : [data]; conflict = options.onConflict; return query },
      update: (data: Row) => { operation = 'update'; rows = [data]; return query },
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
        const fail = `${table}:${operation}`
        if (failures[fail] > 0) { failures[fail]--; return Promise.resolve(resolve({ data: null, error: { code: 'XX000', message: 'secret-provider-error' } })) }
        const target = tables[table] ??= []
        let matches = target.filter(row => filters.every(filter => filter(row)))
        if (operation !== 'select') writes.push({ table, operation, rows: structuredClone(rows) })
        if (operation === 'insert' || operation === 'upsert') {
          matches = rows.map(data => {
            const existing = conflict && target.find(row => conflict.split(',').every(key => row[key.trim()] === data[key.trim()]))
            if (existing) { Object.assign(existing, data); return existing }
            const row = { id: `generated-${nextId++}`, ...data }; target.push(row); return row
          })
        } else if (operation === 'update') matches.forEach(row => Object.assign(row, rows[0]))
        if (range) matches = matches.slice(range[0], range[1] + 1)
        return Promise.resolve(resolve({ data: single ? matches[0] ?? null : structuredClone(matches), error: null }))
      },
    }
    return query
  }
  const rpc = async (_name: string, args: Row) => {
    if (failures.rpc > 0) { failures.rpc--; return { data: null, error: { message: 'secret-provider-error' } } }
    const table = 'gbp_search_keywords_monthly'
    tables[table] = (tables[table] ?? []).filter(row => row.location_id !== args.p_location_id || row.month !== args.p_month)
    tables[table].push(...args.p_rows.map((row: Row) => ({ ...row, location_id: args.p_location_id, month: args.p_month, synced_at: args.p_synced_at })))
    return { data: args.p_rows.length, error: null }
  }
  return { tables, failures, writes, from, rpc }
}
