import type { PGlite } from '@electric-sql/pglite'

/** Small Supabase adapter over real in-memory Postgres for action integration
 * tests. Only query construction is doubled; constraints, joins, transitions,
 * aggregation and transactions execute the migration SQL. */
export function postgresClient(db: PGlite) {
  const calls: Array<{ table?: string; rpc?: string; args?: Record<string, unknown> }> = []
  const failures: Record<string, number> = {}
  const ident = (name: string) => { if (!/^[a-z_]+$/.test(name)) throw new Error(`Unsafe test identifier: ${name}`); return name }
  const client = {
    calls, failures,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ rpc: name, args })
      if (failures[name] > 0) { failures[name]--; return { data: null, error: { message: 'Synthetic storage failure' } } }
      try {
        const keys = Object.keys(args)
        const result = await db.query<{ result: unknown }>(`SELECT ${ident(name)}(${keys.map((key, i) => `${ident(key)} => $${i + 1}`).join(',')}) AS result`, Object.values(args))
        return { data: result.rows[0]?.result, error: null }
      } catch (error) { return { data: null, error: { message: (error as Error).message } } }
    },
    from: (table: string) => {
      calls.push({ table }); ident(table)
      let columns = '*', operation = 'select', patch: Record<string, unknown> = {}, single = false, limit = '', order = ''
      const where: string[] = [], values: unknown[] = []
      const bind = (value: unknown) => { values.push(value); return `$${values.length}` }
      const query = {
        select: (value = '*') => { columns = value; return query },
        eq: (key: string, value: unknown) => { where.push(`${ident(key)} = ${bind(value)}`); return query },
        is: (key: string, value: null) => { if (value !== null) throw new Error('Only null IS supported'); where.push(`${ident(key)} IS NULL`); return query },
        gte: (key: string, value: unknown) => { where.push(`${ident(key)} >= ${bind(value)}`); return query },
        lt: (key: string, value: unknown) => { where.push(`${ident(key)} < ${bind(value)}`); return query },
        in: (key: string, entries: unknown[]) => { where.push(`${ident(key)} IN (${entries.map(bind).join(',')})`); return query },
        not: (key: string, op: string, value: null) => { if (op !== 'is' || value !== null) throw new Error('Unsupported test filter'); where.push(`${ident(key)} IS NOT NULL`); return query },
        or: (condition: string) => { const timestamp = condition.replace('last_completed_at.is.null,last_completed_at.lt.', ''); where.push(`(last_completed_at IS NULL OR last_completed_at < ${bind(timestamp)})`); return query },
        order: (key: string, options?: { ascending?: boolean }) => { order += `${order ? ',' : ' ORDER BY '}${ident(key)} ${options?.ascending === false ? 'DESC' : 'ASC'}`; return query },
        limit: (n: number) => { limit = ` LIMIT ${Number(n)}`; return query },
        single: () => { single = true; return query },
        maybeSingle: () => { single = true; return query },
        update: (value: Record<string, unknown>) => { operation = 'update'; patch = value; return query },
        insert: (value: Record<string, unknown>) => { operation = 'insert'; patch = value; return query },
        then: async (resolve: (value: unknown) => unknown) => {
          try {
            const filter = where.length ? ` WHERE ${where.join(' AND ')}` : ''
            let sql: string
            if (operation === 'update') sql = `UPDATE ${table} SET ${Object.entries(patch).map(([key, value]) => `${ident(key)} = ${bind(value)}`).join(',')} ${filter} RETURNING *`
            else if (operation === 'insert') sql = `INSERT INTO ${table} (${Object.keys(patch).map(ident).join(',')}) VALUES (${Object.values(patch).map(bind).join(',')}) RETURNING *`
            else sql = `SELECT ${columns} FROM ${table}${filter}${order}${limit}`
            const result = await db.query(sql, values)
            return resolve({ data: single ? result.rows[0] ?? null : result.rows, error: null })
          } catch (error) { return resolve({ data: null, error: { message: (error as Error).message } }) }
        },
      }
      return query
    },
  }
  return client
}
