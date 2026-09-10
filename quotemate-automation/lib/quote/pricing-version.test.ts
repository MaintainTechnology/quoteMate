import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureQuotePricingVersion, loadQuotePricingVersion, versionedQuoteGst, versionedEstimationCheckpoint } from './pricing-version'

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const BOOK = 'cccccccc-1111-4111-8111-cccccccccccc'
const INTAKE = 'dddddddd-1111-4111-8111-dddddddddddd'
const QUOTE = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee'
let db: PGlite
let client: SupabaseClient

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table tenants(id uuid primary key);
    create table pricing_book(id uuid primary key, tenant_id uuid, trade text, gst_registered boolean,
      hourly_rate numeric, default_markup_pct numeric, overlays jsonb);
    create table intakes(id uuid primary key, tenant_id uuid, trade text);
    create table quotes(id uuid primary key, tenant_id uuid, intake_id uuid);
    insert into tenants values ('${A}'),('${B}');`)
  await db.exec(readFileSync(resolve(process.cwd(), 'sql/migrations/207_quote_pricing_versions.sql'), 'utf8'))
  client = {
    rpc: async (_name: string, params: Record<string, unknown>) => {
      try {
        const result = await db.query<{ version: unknown }>('select capture_quote_pricing_version($1,$2,$3,$4) as version',
          [params.p_tenant_id, params.p_trade, params.p_book_id, params.p_expected_book])
        return { data: result.rows[0].version, error: null }
      } catch (error) { return { data: null, error } }
    },
    from: (table: string) => {
      const filters: Array<[string, unknown]> = []
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query },
        maybeSingle: async () => {
          const result = await db.query(`select * from ${table} where ${filters.map(([key], index) => `${key}=$${index + 1}`).join(' and ')}`,
            filters.map(([, value]) => value))
          return { data: result.rows[0] ?? null, error: null }
        },
      }
      return query
    },
  } as unknown as SupabaseClient
}, 60_000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  await db.exec('truncate quotes, intakes, quote_pricing_versions, pricing_book')
  await db.query(`insert into pricing_book values($1,$2,'electrical',false,125.50,25,'{}')`, [BOOK, A])
  await db.query(`insert into intakes values($1,$2,'electrical')`, [INTAKE, A])
})
async function book() {
  return (await db.query<{ book: Record<string, unknown> }>('select to_jsonb(pb) as book from pricing_book pb where id=$1', [BOOK])).rows[0].book
}
async function capture() { return captureQuotePricingVersion(client, await book(), A, 'electrical') }
async function attach(id: string, tenant = A) {
  await db.query('insert into quotes(id,tenant_id,intake_id,pricing_book_version_id) values($1,$2,$3,$4)', [QUOTE, tenant, INTAKE, id])
}
describe('immutable quote pricing snapshots — actual migration and RPC', () => {
  it('captures the exact owned book and reuses the same immutable version', async () => {
    const first = await capture(); const second = await capture()
    expect(second.id).toBe(first.id)
    expect(first.snapshot).toMatchObject({ id: BOOK, tenant_id: A, trade: 'electrical', gst_registered: false, hourly_rate: 125.5 })
    expect(first.content_hash).toMatch(/^[a-f0-9]{64}$/)
    await attach(first.id)
    const loaded = await loadQuotePricingVersion(client, { tenant_id: A, pricing_book_version_id: first.id }, 'electrical')
    expect(loaded).toMatchObject({ id: first.id, snapshot: first.snapshot, content_hash: first.content_hash })
  })
  it('keeps historical rates/GST when the current book changes or is deleted', async () => {
    const first = await capture(); await attach(first.id)
    await db.query('update pricing_book set hourly_rate=200,gst_registered=true where id=$1', [BOOK])
    const second = await capture()
    expect(second.id).not.toBe(first.id)
    await db.query('delete from pricing_book where id=$1', [BOOK])
    const old = await loadQuotePricingVersion(client, { tenant_id: A, pricing_book_version_id: first.id }, 'electrical')
    expect(old?.snapshot).toMatchObject({ hourly_rate: 125.5, gst_registered: false })
    expect(versionedQuoteGst({ selected_tier: 'good', good: { subtotal_ex_gst: 100 }, total_inc_gst: 100 }, old)).toBe(false)
  })
  it('rejects a book changing between estimator read and version capture', async () => {
    const original = await book()
    await db.query('update pricing_book set gst_registered=true where id=$1', [BOOK])
    await expect(captureQuotePricingVersion(client, original, A, 'electrical')).rejects.toMatchObject({ code: 'pricing_revision_changed' })
    expect((await db.query('select * from quote_pricing_versions')).rows).toHaveLength(0)
  })
  it('rejects missing tax instead of defaulting registration', async () => {
    await db.query('update pricing_book set gst_registered=null where id=$1', [BOOK])
    await expect(capture()).rejects.toMatchObject({ code: 'quote_pricing_review_required' })
    await expect(db.query('select capture_quote_pricing_version($1,$2,$3,$4)', [A, 'electrical', BOOK, await book()])).rejects.toThrow(/owned pricing book required/)
  })
  it('rejects foreign and wrong-trade captures and reads', async () => {
    await expect(captureQuotePricingVersion(client, await book(), B, 'electrical')).rejects.toMatchObject({ code: 'quote_pricing_review_required' })
    const saved = await capture()
    await expect(loadQuotePricingVersion(client, { tenant_id: B, pricing_book_version_id: saved.id }, 'electrical')).rejects.toMatchObject({ code: 'quote_pricing_review_required' })
    await expect(loadQuotePricingVersion(client, { tenant_id: A, pricing_book_version_id: saved.id }, 'plumbing')).rejects.toMatchObject({ code: 'quote_pricing_review_required' })
    await expect(attach(saved.id, B)).rejects.toThrow(/ownership mismatch/)
  })
  it('rejects snapshot mutation and replacement of an attached quote version', async () => {
    const first = await capture(); await attach(first.id)
    await expect(db.query("update quote_pricing_versions set snapshot='{}' where id=$1", [first.id])).rejects.toThrow(/immutable/)
    await db.query('update pricing_book set hourly_rate=200 where id=$1', [BOOK])
    const next = await capture()
    await expect(db.query('update quotes set pricing_book_version_id=$1 where id=$2', [next.id, QUOTE])).rejects.toThrow(/immutable/)
  })
  it('allows explicit captured GST for a zero-priced new final draft without inferring tax from zero', async () => {
    const saved = await capture()
    const zero = { selected_tier: 'good', good: { subtotal_ex_gst: 0 }, total_inc_gst: 0 }
    expect(versionedQuoteGst(zero, saved)).toBe(false)
    expect(versionedQuoteGst(zero, null)).toBeNull()
    expect(versionedQuoteGst({ ...zero, total_inc_gst: 50 }, saved)).toBeNull()
  })
  it('does not attach today’s book to unversioned legacy quotes', async () => {
    expect(await loadQuotePricingVersion(client, { tenant_id: A }, 'electrical')).toBeNull()
    expect((await db.query('select * from quote_pricing_versions')).rows).toHaveLength(0)
  })
  it('denies authenticated direct snapshot writes and capture RPC', async () => {
    await db.exec('set role authenticated')
    try {
      await expect(db.query('select capture_quote_pricing_version($1,$2,$3,$4)', [A, 'electrical', BOOK, {}])).rejects.toThrow(/permission denied/)
      await expect(db.query('select * from quote_pricing_versions')).rejects.toThrow(/permission denied/)
    } finally { await db.exec('reset role') }
  })

  it('resumes a cached estimate with its original book and GST after the current book changes', async () => {
    let cached: unknown
    const checkpoint = async <R>(_name: string, factory: () => Promise<R>): Promise<R> => {
      if (cached === undefined) cached = await factory()
      return cached as R
    }
    const run = vi.fn(async () => ({ draft: { total: 125.5 } }))
    const original = await versionedEstimationCheckpoint(client, { tenantId: A, trade: 'electrical', book: await book(), checkpoint, run })
    await db.query('update pricing_book set hourly_rate=200,gst_registered=true where id=$1', [BOOK])
    const resumed = await versionedEstimationCheckpoint(client, { tenantId: A, trade: 'electrical', book: await book(), checkpoint, run })
    expect(resumed.pricingVersion?.id).toBe(original.pricingVersion?.id)
    expect(resumed.pricingVersion?.snapshot).toMatchObject({ hourly_rate: 125.5, gst_registered: false })
    expect(resumed.estimation.draft.total).toBe(125.5)
    expect(run).toHaveBeenCalledTimes(1)
    expect((await db.query('select * from quote_pricing_versions')).rows).toHaveLength(1)
    await db.query('delete from pricing_book where id=$1', [BOOK])
    const afterDeletion = await versionedEstimationCheckpoint(client, { tenantId: A, trade: 'electrical', book: null, checkpoint, run })
    expect(afterDeletion.pricingVersion?.id).toBe(original.pricingVersion?.id)
  })

  it('blocks an unversioned cached result without capturing today’s book or rerunning the model', async () => {
    const run = vi.fn(async () => ({ draft: { total: 100 } }))
    const checkpoint = async <R,>(): Promise<R> => ({ draft: { total: 75 } }) as R
    await expect(versionedEstimationCheckpoint(client, { tenantId: A, trade: 'electrical', book: await book(), checkpoint, run }))
      .rejects.toMatchObject({ code: 'quote_pricing_review_required' })
    expect(run).not.toHaveBeenCalled()
    expect((await db.query('select * from quote_pricing_versions')).rows).toHaveLength(0)
  })

  it('captures before estimation and blocks a changed input book before invoking the model', async () => {
    const original = await book()
    await db.query('update pricing_book set hourly_rate=200 where id=$1', [BOOK])
    const run = vi.fn(async () => ({ draft: {} }))
    const checkpoint = async <R>(_name: string, factory: () => Promise<R>) => factory()
    await expect(versionedEstimationCheckpoint(client, { tenantId: A, trade: 'electrical', book: original, checkpoint, run }))
      .rejects.toMatchObject({ code: 'pricing_revision_changed' })
    expect(run).not.toHaveBeenCalled()
  })
})
