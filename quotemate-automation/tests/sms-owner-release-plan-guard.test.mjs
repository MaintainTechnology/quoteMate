import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createRouteFixtureDb } from '../scripts/sms-route-fixture-db.mjs'

// Actual migrations 201/199/212 and PostgreSQL row triggers. PGlite supplies one
// serialized connection: these tests establish both orderings, not live races.
const app = fileURLToPath(new URL('../', import.meta.url))
let db
const tenant = '11111111-1111-4111-8111-111111111111'
const phone = '+61411111111'
const migration = name => readFileSync(join(app, 'sql/migrations', name), 'utf8')
beforeAll(async () => {
  db = await createRouteFixtureDb(app)
  await db.seed('tenants', [{ id: tenant }])
  await db.pg.exec(migration('212_plan_quote_release_guard.sql'))
}, 60_000)
afterAll(async () => { await db?.pg.close() })

async function plan() {
  const row = { id: randomUUID(), tenant_id: tenant, plan_upload_id: randomUUID(), trade: 'electrical',
    share_token: randomUUID().replaceAll('-', ''), items: [{ type: 'GPO', count: 2 }],
    corrected_items: [{ type: 'GPO', count: 2 }], priced_bom: { totalIncGst: 242 },
    sheets_used: ['E1'], overall_note: 'Reviewed scope', model: 'fixture', sms_source_key: randomUUID(),
    report_pdf_path: null, updated_at: '2026-09-09T00:00:00Z' }
  await db.seed('plan_extractions', [row])
  await db.seed('plan_upload_requests', [{ tenant_id: tenant, plan_extraction_id: row.id, customer_phone: phone }])
  return (await db.pg.query('select to_jsonb(e) as row from plan_extractions e where id=$1', [row.id])).rows[0].row
}
const load = async id => (await db.pg.query('select to_jsonb(e) as row from plan_extractions e where id=$1', [id])).rows[0]?.row
const outbound = row => ({ tenantId: tenant, resourceToken: row.share_token, to: phone, from: '+61488888888',
  text: `Your reviewed plan: https://quotemax.com.au/q/plan/${row.share_token}` })
async function release(row, snapshot = row) {
  return db.pg.query("select sms_release_quote_resource($1,'plan',$2,$3,$4,$5,$6)",
    [tenant, row.id, phone, JSON.stringify(outbound(row)), `hash-${row.id}`, snapshot ? JSON.stringify(snapshot) : null])
}

describe('migration212 preserves the actually released plan resource', () => {
  it('permits rollback before release without deleting held results, then safely reapplies', async () => {
    const held = await plan()
    await db.pg.exec(migration('212_plan_quote_release_guard_down.sql'))
    expect((await db.pg.query("select to_regprocedure('public.sms_plan_quote_guard_ready()') as ready")).rows[0].ready).toBeNull()
    expect(await load(held.id)).toEqual(held)
    await db.pg.exec(migration('212_plan_quote_release_guard.sql'))
    expect((await db.pg.query('select sms_plan_quote_guard_ready() as ready')).rows[0].ready).toBe(true)
  })
  it.each([
    ['corrected_items', [{ type: 'GPO', count: 8 }]], ['items', [{ type: 'GPO', count: 8 }]],
    ['priced_bom', { totalIncGst: 968 }], ['share_token', 'different_public_token'],
    ['tenant_id', '99999999-9999-4999-8999-999999999999'], ['plan_upload_id', '88888888-8888-4888-8888-888888888888'],
    ['id', '77777777-7777-4777-8777-777777777777'], ['trade', 'commercial_painting'],
    ['sms_source_key', 'different_source'], ['sheets_used', ['E2']], ['overall_note', 'Unreviewed scope'],
    ['released_at', null], ['priced_at', '2026-09-10T00:00:00Z'],
  ])('rejects changed %s after actual201 owner release and preserves one original intent', async (key, value) => {
    const row = await plan()
    await release(row)
    const approved = await load(row.id)
    expect(approved.released_at).toBeTruthy()
    await expect(db.pg.query(`update plan_extractions set ${key}=$1 where id=$2`,
      [value !== null && typeof value === 'object' ? JSON.stringify(value) : value, row.id])).rejects.toMatchObject({ code: 'QM001', message: 'released_quote_immutable' })
    expect(await load(row.id)).toEqual(approved)
    await release(row, approved)
    const intents = await db.pg.query('select id from sms_outbox where delivery_key=$1', [`quote-release:plan:${row.id}`])
    expect(intents.rows).toHaveLength(1)
  })
  it('rejects deletion and truncation of published rows', async () => {
    const row = await plan(); await release(row)
    await expect(db.pg.query('delete from plan_extractions where id=$1', [row.id])).rejects.toMatchObject({ code: 'QM001' })
    await expect(db.pg.exec('truncate plan_extractions')).rejects.toMatchObject({ code: 'QM001' })
    expect(await load(row.id)).toMatchObject({ id: row.id, priced_bom: row.priced_bom })
  })
  it('allows saved PDF cache backfill and ordinary held edits/deletes', async () => {
    const row = await plan(); await release(row)
    const approved = await load(row.id)
    await db.pg.query("update plan_extractions set report_pdf_path='approved/report.pdf',updated_at='2026-09-10T00:00:00Z' where id=$1", [row.id])
    expect(await load(row.id)).toMatchObject({ ...approved, report_pdf_path: 'approved/report.pdf', updated_at: '2026-09-10T00:00:00Z' })
    const held = await plan()
    await db.pg.query("update plan_extractions set corrected_items='[{\"type\":\"GPO\",\"count\":8}]',priced_bom=null where id=$1", [held.id])
    await db.pg.query('delete from plan_extractions where id=$1', [held.id])
    expect(await load(held.id)).toBeUndefined()
  })
  it('rejects stale review when editing wins first, and rejects editing when actual release wins first', async () => {
    const row = await plan()
    await db.pg.query("update plan_extractions set corrected_items='[{\"type\":\"GPO\",\"count\":8}]' where id=$1", [row.id])
    await expect(release(row)).rejects.toThrow('Quote changed after review')
    expect((await db.pg.query('select id from sms_outbox where delivery_key=$1', [`quote-release:plan:${row.id}`])).rows).toHaveLength(0)
    const changed = await load(row.id); await release(changed)
    await expect(db.pg.query("update plan_extractions set priced_bom='{}' where id=$1", [row.id])).rejects.toMatchObject({ code: 'QM001' })
    expect((await load(row.id)).corrected_items).toEqual([{ type: 'GPO', count: 8 }])
  })
  it('fails closed on RLS-hidden released rows when a restricted role can truncate', async () => {
    const row = await plan(); await release(row)
    expect((await load(row.id)).released_at).toBeTruthy()
    await db.pg.exec("create role plan_truncator; grant select,truncate on plan_extractions to plan_truncator; alter table plan_extractions enable row level security; create policy hide_plans on plan_extractions for select to plan_truncator using(false); set role plan_truncator")
    try {
      expect((await db.pg.query('select count(*)::int as count from plan_extractions')).rows[0].count).toBe(0)
      await expect(db.pg.exec('truncate plan_extractions')).rejects.toThrow(/row-level security|released_quote_immutable/i)
    } finally { await db.pg.exec('reset role; alter table plan_extractions disable row level security') }
  })
  it('binds readiness to enabled full-event triggers and restricts execution to service_role', async () => {
    expect((await db.pg.query('select sms_plan_quote_guard_ready() as ready')).rows[0].ready).toBe(true)
    expect((await db.pg.query("select has_function_privilege('anon','sms_plan_quote_guard_ready()','execute') as anon,has_function_privilege('authenticated','sms_plan_quote_guard_ready()','execute') as authenticated,has_function_privilege('service_role','sms_plan_quote_guard_ready()','execute') as service")).rows[0]).toEqual({ anon: false, authenticated: false, service: true })
    await db.pg.exec('alter table plan_extractions disable trigger sms_plan_quote_guard')
    expect((await db.pg.query('select sms_plan_quote_guard_ready() as ready')).rows[0].ready).toBe(false)
    await db.pg.exec('alter table plan_extractions enable trigger sms_plan_quote_guard; drop trigger sms_plan_quote_truncate_guard on plan_extractions')
    expect((await db.pg.query('select sms_plan_quote_guard_ready() as ready')).rows[0].ready).toBe(false)
    await db.pg.exec(migration('212_plan_quote_release_guard.sql'))
    expect((await db.pg.query('select sms_plan_quote_guard_ready() as ready')).rows[0].ready).toBe(true)
    const protectedRow = await plan(); await release(protectedRow)
    const approved = await load(protectedRow.id)
    await expect(db.pg.exec(migration('212_plan_quote_release_guard_down.sql'))).rejects.toThrow('Cannot remove plan release guard while published plans exist')
    await db.pg.exec('rollback')
    expect((await db.pg.query('select sms_plan_quote_guard_ready() as ready')).rows[0].ready).toBe(true)
    expect(await load(protectedRow.id)).toEqual(approved)
  })
})
