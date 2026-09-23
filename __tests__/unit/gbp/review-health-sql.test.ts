import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { reviewDatabase, HEALTH_MIGRATION, LOCATION, seedReview, seedLocation } from '../../helpers/gbp-postgres'
let db: PGlite
beforeAll(async () => { db = await reviewDatabase([HEALTH_MIGRATION]) }, 30_000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  await db.exec('TRUNCATE gbp_locations, gbp_reviews, gbp_review_replies, gbp_review_health_daily, app_users CASCADE')
  await seedLocation(db)
})
const capture = (time = '2026-09-23T04:45:00Z', rating: number | null = 4.57219, count: number | null = 3883) => db.query('SELECT capture_gbp_review_health($1,$2,$3,$4)', [LOCATION, rating, count, time])
const snapshot = async () => (await db.query('SELECT * FROM gbp_review_health_daily ORDER BY snapshot_date DESC')).rows as Record<string, unknown>[]
describe('snapshot SQL', () => {
  it('upserts once per location/day, keeps precision and retains daily history', async () => {
    await capture(); await capture();
    expect(await snapshot()).toHaveLength(1)
    expect((await snapshot())[0]).toMatchObject({ average_rating: '4.57219', total_review_count: 3883 })
    await capture('2026-09-24T04:45:00Z', 4.58, 3890)
    expect(await snapshot()).toHaveLength(2)
    await capture('2026-09-24T05:45:00Z', null, null)
    expect((await snapshot())[0].average_rating).toBe('4.58')
  })
  it('counts Copenhagen calendar days and treats drafts as unanswered', async () => {
    await seedReview(db, 1, '2026-09-16T21:59:59Z', 'awaiting_review') // outside the seven dates
    await seedReview(db, 2, '2026-09-16T22:00:00Z', 'awaiting_review') // midnight Sept 17 CPH
    await seedReview(db, 3, '2026-09-23T04:00:00Z', 'published')
    await seedReview(db, 4, '2026-09-23T04:00:00Z', 'externally_published')
    await seedReview(db, 5, '2026-09-23T04:00:00Z', undefined, 'Synthetic external reply')
    await capture()
    expect((await snapshot())[0]).toMatchObject({ new_reviews_7d: 4, unanswered_count: 2 })
  })
  it('never truncates aggregates at PostgREST’s 1000-row boundary', async () => {
    await db.query(`INSERT INTO gbp_reviews (google_review_id,location_id,star_rating,review_created_at,review_updated_at)
      SELECT 'synthetic-' || n, $1, 5, '2026-09-23T04:00:00Z', '2026-09-23T04:00:00Z' FROM generate_series(1,3883) n`, [LOCATION])
    await capture()
    expect((await snapshot())[0]).toMatchObject({ new_reviews_7d: 3883, unanswered_count: 3883 })
  })
  it('retains the last good row on invalid data and out-of-order writes', async () => {
    await capture()
    await expect(capture('2026-09-23T05:00:00Z', 6)).rejects.toThrow()
    await capture('2026-09-23T03:00:00Z', 4, 200)
    expect((await snapshot())[0]).toMatchObject({ average_rating: '4.57219', total_review_count: 3883 })
  })
  it('enables RLS, grants only service_role table and RPC access', async () => {
    const rows = (await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'gbp_review_health_daily'`)).rows
    expect(rows[0]).toMatchObject({ relrowsecurity: true })
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`)
      await expect(db.query('SELECT * FROM gbp_review_health_daily')).rejects.toThrow('permission denied')
      await expect(capture()).rejects.toThrow('permission denied')
      await db.exec('RESET ROLE')
    }
    await db.exec('SET ROLE service_role')
    await capture()
    expect(await snapshot()).toHaveLength(1)
    await db.exec('RESET ROLE')
  })
})
