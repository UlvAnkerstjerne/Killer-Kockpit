// Minimal chainable Supabase fake for rendering server pages in unit tests.
//
// mode 'rls-leak': ignores ownership filters (user_id / owner_user_id / ...) and returns other users' rows — simulates RLS letting
//   manager roles read other users' rows, so only explicit app-side ownership filters protect.
// mode 'honest-eq': applies every `.eq()` / `.neq()` like the database would — proves queries carry
//   the owner filter.

type Row = Record<string, unknown>
const OWNER_COLS = new Set(['user_id', 'owner_user_id', 'created_by_user_id', 'completed_by_user_id'])
export type FakeMode = 'rls-leak' | 'honest-eq'

export function createFakeSupabase(tables: Record<string, Row[]>, mode: FakeMode) {
  function builder(table: string) {
    const eqs: [string, unknown][] = []
    const neqs: [string, unknown][] = []
    const b: Record<string, unknown> = {}
    const chain = () => b
    const preds: ((r: Row) => boolean)[] = [] // non-ownership filters apply in every mode
    b.is = (c: string, v: unknown) => { preds.push(r => (v === null ? r[c] == null : r[c] === v)); return b }
    b.not = (c: string, op: string, v: unknown) => {
      if (op === 'is') preds.push(r => (v === null ? r[c] != null : r[c] !== v))
      else if (op === 'eq') preds.push(r => r[c] !== v)
      else if (op === 'in') {
        const vals = String(v).replace(/[()"]/g, '').split(',')
        preds.push(r => !vals.includes(String(r[c])))
      }
      return b
    }
    b.in = (c: string, vals: unknown[]) => { preds.push(r => vals.includes(r[c])); return b }
    for (const m of ['select', 'or', 'order', 'limit', 'lt', 'lte', 'gt', 'gte', 'ilike', 'contains']) {
      b[m] = chain
    }
    b.eq = (c: string, v: unknown) => { eqs.push([c, v]); return b }
    b.neq = (c: string, v: unknown) => { neqs.push([c, v]); return b }
    const result = () => {
      let rows = (tables[table] ?? []).filter(r => preds.every(p => p(r)))
      // Non-ownership equality filters (status, ...) always apply; ownership columns only in honest mode.
      const isOwnerCol = (c: string) => OWNER_COLS.has(c)
      rows = rows.filter(r =>
        eqs.every(([c, v]) => (mode === 'rls-leak' && isOwnerCol(c)) || r[c] === v) &&
        neqs.every(([c, v]) => (mode === 'rls-leak' && isOwnerCol(c)) || r[c] !== v))
      return { data: rows, error: null, count: rows.length }
    }
    b.maybeSingle = async () => ({ data: result().data[0] ?? null, error: null })
    b.single = b.maybeSingle
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej)
    return b
  }
  return { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) }
}
