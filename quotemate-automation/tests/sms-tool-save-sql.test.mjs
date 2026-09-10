import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { createRouteFixtureDb } from '../scripts/sms-route-fixture-db.mjs'
import { commercialPaintSaveIdentity, persistPaintDraftRow, readSavedPaintQuote } from '@/lib/commercial-painting/saved-quote'

// Actual route fixture schema and migrations, with a small query adapter. This
// proves database uniqueness/readback, not production multi-connection locking.
const tenantId = '11111111-1111-4111-8111-111111111111'
const source = { runId: 'aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee', extractionId: 'bbbbbbbb-cccc-4ddd-aeee-ffffffffffff', pricedAt: '2026-09-09T00:00:00.000Z', customerPhone: '+61412345678' }
const ids = commercialPaintSaveIdentity(tenantId, source.runId, source.extractionId, source.pricedAt)
let database, loseResponse
const client = { from(table) {
  const state = { table, action: 'select', filters: [], orders: [] }
  const q = {
    select(columns) { state.columns = columns; return q },
    eq(key, value) { state.filters.push({ op: 'eq', key, value }); return q },
    upsert(payload, options) { Object.assign(state, { action: 'upsert', payload, conflict: options.onConflict, ignoreDuplicates: options.ignoreDuplicates }); return q },
    maybeSingle() { state.single = 'maybeSingle'; return q },
    then(resolve, reject) { return database.query(state).then((result) => {
      if (loseResponse && state.action === 'upsert' && table === 'quotes') { loseResponse = false; throw new Error('Response lost after PostgreSQL commit') }
      return result
    }).then(resolve, reject) },
  }
  return q
} }

beforeAll(async () => {
  database = await createRouteFixtureDb(fileURLToPath(new URL('../', import.meta.url)))
  await database.pg.exec(readFileSync(new URL('../sql/migrations/205_generic_quote_customer_release.sql', import.meta.url), 'utf8'))
  await database.seed('tenants', [{ id: tenantId, trade: 'commercial_painting', business_name: 'Offline Painting' }])
}, 60000)
afterAll(async () => { await database?.close() })

describe('commercial save identity at the PostgreSQL boundary', () => {
  it('retains one immutable owned draft through committed-response loss, competing tokens and replay after release', async () => {
    await persistPaintDraftRow(client, 'intakes', {
      id: ids.intakeId, tenant_id: tenantId, trade: 'commercial_painting',
      scope: { paint_run_id: source.runId, extraction_id: source.extractionId, priced_at: source.pricedAt },
      caller: { name: 'Sam', phone: source.customerPhone, email: '' },
    })
    const draft = { id: ids.quoteId, tenant_id: tenantId, intake_id: ids.intakeId, status: 'draft',
      share_token: 'offline_original_tender_token', good: { subtotal_ex_gst: 1000 },
      better: { subtotal_ex_gst: 1000 }, best: { subtotal_ex_gst: 1000 }, total_inc_gst: 1100, pdf_path: null }
    loseResponse = true
    await Promise.all([
      persistPaintDraftRow(client, 'quotes', draft),
      persistPaintDraftRow(client, 'quotes', { ...draft, share_token: 'offline_losing_tender_token', total_inc_gst: 2200 }),
    ])
    const rows = (await database.pg.query('select id,share_token,total_inc_gst,status from quotes')).rows
    expect(rows).toEqual([{ id: ids.quoteId, share_token: draft.share_token, total_inc_gst: '1100', status: 'draft' }])
    expect((await readSavedPaintQuote(client, tenantId, ids.quoteId, source)).share_token).toBe(draft.share_token)
    await expect(readSavedPaintQuote(client, tenantId, ids.quoteId, { ...source, extractionId: 'cccccccc-dddd-4eee-afff-aaaaaaaaaaaa' })).rejects.toThrow('pricing pass')
    expect(await readSavedPaintQuote(client, '99999999-9999-4999-8999-999999999999', ids.quoteId, source)).toBeNull()
    await database.pg.query("update quotes set status='paid',customer_released_at=now() where id=$1", [ids.quoteId])
    await persistPaintDraftRow(client, 'quotes', { ...draft, share_token: 'offline_retry_tender_token', total_inc_gst: 3300 })
    expect((await database.pg.query('select id,share_token,total_inc_gst,status from quotes')).rows).toEqual([{ ...rows[0], status: 'paid' }])
    expect((await database.pg.query('select count(*)::int as n from intakes')).rows[0].n).toBe(1)
  })
})
