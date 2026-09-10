import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/tenant/job-quote/route'
import { GET } from '@/app/api/tenant/job-quote/operations/[operationId]/route'
import { jobQuoteRequestHash, readQuoteDraftReadiness, validJobQuoteMedia } from './job-quote-operation'

const mocks = vi.hoisted(() => ({
  client: {} as SupabaseClient, tenant: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  structure: vi.fn(), embed: vi.fn(), sign: vi.fn(), fetch: vi.fn(),
  gate: vi.fn(), resolve: vi.fn(),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => new Proxy({}, { get: (_, property) => Reflect.get(mocks.client, property) }) }))
vi.mock('@/lib/features/guard', () => ({ requireFeature: mocks.gate }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: mocks.resolve }))
vi.mock('@/lib/intake/structure', () => ({ structureIntake: mocks.structure }))
vi.mock('@/lib/intake/embed', () => ({ embedIntake: mocks.embed }))
vi.mock('@/lib/storage/upload', () => ({ refreshSignedUrl: mocks.sign }))
vi.mock('@/lib/customers/lookup', () => ({ findOrCreateCustomer: vi.fn(async () => null) }))

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const OP = 'dddddddd-1111-4111-8111-dddddddddddd'
const Q = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee'
const path = `jobquote-${A}-0123456789abcdef/1788840000000-0-01234567.jpg`
const input = { job_type: 'ev_charger', address: '12 Smith St', suburb: 'Penrith', answers: { charger_supply: 'customer already has the charger', phase: 'three phase (on-site inspection)' }, notes: '', customer_name: 'Private name', customer_email: '', customer_mobile: '' }
const body = { ...input, operation_id: OP }
let db: PGlite
let failIntakeResponse = false
let failClaim = false

// Execute the production query/RPC boundaries against the actual migration in
// local PostgreSQL WASM. Only provider/auth/HTTP boundaries are mocked.
function adapter(): SupabaseClient {
  return {
    rpc: async (_name: string, params: Record<string, unknown>) => {
      if (failClaim) return { data: null, error: { message: 'database unavailable' } }
      try {
        const result = await db.query<{ receipt: unknown }>('select claim_job_quote_operation($1,$2,$3,$4) as receipt', [params.p_tenant_id, params.p_operation_id, params.p_request_hash, params.p_pin_requested])
        return { data: result.rows[0].receipt, error: null }
      } catch (error) { return { data: null, error } }
    },
    from: (table: string) => {
      let columns = '*'; let action = 'select'; let changes: Record<string, unknown> = {}
      const predicates: Array<[string, unknown]> = []; let cap: number | undefined; let mode = 'array'; let disjunction: Array<[string, string]> = []
      const query = {
        select: (value: string) => { columns = value; return query },
        eq: (key: string, value: unknown) => { predicates.push([key, value]); return query },
        is: (key: string, value: unknown) => { predicates.push([key, value]); return query },
        or: (value: string) => { disjunction = value.split(',').map(part => { const [column, operator, operand] = part.split('.'); if (operator !== 'eq') throw new Error('Unsupported test operator'); return [column, operand] }); return query },
        limit: (value: number) => { cap = value; return query },
        maybeSingle: () => { mode = 'maybe'; return query },
        single: () => { mode = 'single'; return query },
        insert: (value: Record<string, unknown>) => { action = 'insert'; changes = value; return query },
        update: (value: Record<string, unknown>) => { action = 'update'; changes = value; return query },
        then: (ok: (value: unknown) => unknown, fail: (error: unknown) => unknown) => run().then(ok, fail),
      }
      async function run() {
        try {
          const values: unknown[] = []
          const bind = (value: unknown) => { values.push(value); return `$${values.length}` }
          const entries = Object.entries(changes).filter(([, value]) => value !== undefined)
          let sql = action === 'insert' ? `insert into ${table} (${entries.map(([key]) => key)}) values (${entries.map(([,value]) => bind(value))})`
            : action === 'update' ? `update ${table} set ${entries.map(([key,value]) => `${key}=${bind(value)}`).join(',')}` : `select ${columns} from ${table}`
          if (predicates.length) sql += ` where ${predicates.map(([key,value]) => value === null ? `${key} is null` : `${key}=${bind(value)}`).join(' and ')}`
          if (disjunction.length) sql += `${predicates.length ? ' and' : ' where'} (${disjunction.map(([key, value]) => `${key}=${bind(value)}`).join(' or ')})`
          if (action === 'select' && cap) sql += ` limit ${cap}`
          if (action !== 'select') sql += ` returning ${columns}`
          const result = await db.query(sql, values)
          if (table === 'intakes' && action === 'insert' && failIntakeResponse) throw new Error('lost INSERT acknowledgement')
          const rows = JSON.parse(JSON.stringify(result.rows)) as unknown[]
          if (mode !== 'array' && (rows.length > 1 || (mode === 'single' && rows.length !== 1))) throw new Error('Unexpected row count')
          return { data: mode === 'array' ? rows : rows[0] ?? null, error: null }
        } catch (error) { return { data: null, error } }
      }
      return query
    },
  } as unknown as SupabaseClient
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table tenants(id uuid primary key);
    create table intakes(id uuid primary key default gen_random_uuid(), tenant_id uuid, customer_id uuid,
      trade text, job_type text, address text, suburb text, scope jsonb, access jsonb, property jsonb,
      risks jsonb, inspection_required boolean, caller jsonb, timing jsonb, confidence text, confidence_reason text,
      photo_paths text[], embedding jsonb);
    create table quotes(id uuid primary key, tenant_id uuid, intake_id uuid, parent_quote_id uuid,
      share_token text, needs_inspection boolean);
    create table sms_work_jobs(work_key text primary key, kind text, status text, result jsonb);
    create table tenant_material_catalogue(id uuid primary key, tenant_id uuid, name text, unit_price_ex_gst text,
      image_path text, description text, category text, trade text, properties jsonb, active boolean);
    insert into tenants values ('${A}'),('${B}');`)
  await db.exec(readFileSync(resolve(process.cwd(), 'sql/migrations/202_job_quote_operations.sql'), 'utf8'))
  mocks.client = adapter()
}, 60_000)
afterAll(async () => { vi.unstubAllGlobals(); await db?.close() })
beforeEach(async () => {
  await db.exec('truncate job_quote_operations, quotes, intakes, sms_work_jobs, tenant_material_catalogue')
  vi.clearAllMocks(); failIntakeResponse = false; failClaim = false; mocks.tenant = A
  mocks.gate.mockImplementation(async () => ({ ok: true, tenant: { id: mocks.tenant, trades: ['electrical'] } }))
  mocks.resolve.mockImplementation(async () => ({ tenant: { id: mocks.tenant } }))
  mocks.structure.mockImplementation(async () => ({ trade: 'electrical', job_type: 'ev_charger', address: '', suburb: '', scope: { description: 'EV installation' }, risks: [], inspection_required: false, caller: { name: '', phone: '' }, confidence: 'HIGH', confidence_reason: 'answers' }))
  mocks.embed.mockResolvedValue([0.1, 0.2]); mocks.sign.mockResolvedValue('https://storage.example/owned-signed-image')
  mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
    const { intakeId } = JSON.parse(String(init.body)) as { intakeId: string }
    await saveQuote(intakeId)
    return Response.json({ ok: true, quoteId: Q })
  })
  vi.stubGlobal('fetch', mocks.fetch)
})
const request = (value: unknown = body) => new Request('https://app.example/api/tenant/job-quote', { method: 'POST', body: JSON.stringify(value) })
const status = (id = OP) => GET(new Request('https://app.example/api/tenant/job-quote/operations/' + id), { params: Promise.resolve({ operationId: id }) })
async function saveQuote(intakeId: string, tenantId = A) {
  await db.query('insert into quotes(id, tenant_id, intake_id, share_token, needs_inspection) values($1,$2,$3,$4,true)', [Q, tenantId, intakeId, 'owned-share-token'])
}
async function receipt() { return (await db.query<{ intake_id: string }>('select intake_id from job_quote_operations where operation_id=$1', [OP])).rows[0] }

describe('T02 operation route, immutable claim and authoritative readback', () => {
  it('concurrent same input creates one intake/quote and lost completed response is recoverable without providers', async () => {
    const responses = await Promise.all([POST(request()), POST(request())])
    expect(responses.map(value => value.status).sort()).toEqual([200, 202])
    expect(mocks.structure).toHaveBeenCalledTimes(1); expect(mocks.embed).toHaveBeenCalledTimes(1); expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect((await db.query('select * from intakes')).rows).toHaveLength(1)
    expect((await db.query('select * from quotes')).rows).toHaveLength(1)
    expect(await (await status()).json()).toMatchObject({ operationId: OP, status: 'completed', quoteId: Q })
    expect(await (await POST(request())).json()).toMatchObject({ status: 'completed', quoteId: Q })
    expect(await (await POST(request({ ...body, operation_id: OP.toUpperCase() }))).json()).toMatchObject({ operationId: OP, status: 'completed' })
    expect(await (await status(OP.toUpperCase())).json()).toMatchObject({ operationId: OP, status: 'completed' })
    expect(mocks.structure).toHaveBeenCalledTimes(1)
    const stored = (await db.query('select * from job_quote_operations')).rows[0]
    expect(JSON.stringify(stored)).not.toContain('Private name')
  })

  it('changed input conflicts and cannot mutate a claimed identity', async () => {
    await POST(request())
    const response = await POST(request({ ...body, notes: 'different work' }))
    expect(response.status).toBe(409); expect(mocks.structure).toHaveBeenCalledTimes(1)
    await expect(db.query('update job_quote_operations set request_hash=$1', ['a'.repeat(64)])).rejects.toThrow(/immutable/)
    await expect(db.query("update job_quote_operations set status='processing'")).rejects.toThrow(/immutable/)
  })

  it('GET denies another tenant, while the same operation UUID has an independent tenant namespace', async () => {
    await POST(request())
    mocks.tenant = B
    expect((await status()).status).toBe(404)
    expect(mocks.structure).toHaveBeenCalledTimes(1)
    const claim = await mocks.client.rpc('claim_job_quote_operation', { p_tenant_id: B, p_operation_id: OP, p_request_hash: 'a'.repeat(64), p_pin_requested: false })
    expect(claim.data.claimed).toBe(true)
    expect(await (await status()).json()).toMatchObject({ status: 'processing' })
  })

  it('rejects auth, malformed IDs, foreign/duplicate/mismatched photo paths before claiming or AI', async () => {
    mocks.gate.mockResolvedValueOnce({ ok: false, status: 401, body: { ok: false, error: 'unauthorized' } })
    expect((await POST(request())).status).toBe(401)
    expect((await POST(request({ ...body, operation_id: 'bad' }))).status).toBe(400)
    for (const photoFields of [
      { photo_paths: [path.replace(A, B)] }, { photo_paths: [path, path] },
      { photo_urls: ['http://169.254.169.254/secret'] },
      { photo_paths: [path], photo_urls: ['https://one', 'https://two'] },
    ]) expect((await POST(request({ ...body, ...photoFields }))).status).toBe(400)
    expect((await db.query('select * from job_quote_operations')).rows).toHaveLength(0)
    expect(mocks.structure).not.toHaveBeenCalled(); expect(mocks.sign).not.toHaveBeenCalled()
  })

  it('uses only server signed URLs and URL rotation preserves immutable input/media identity', async () => {
    const photos = { photo_paths: [path], photo_urls: ['http://169.254.169.254/ignored'] }
    expect((await POST(request({ ...body, ...photos }))).status).toBe(200)
    expect(mocks.sign).toHaveBeenCalledWith(path)
    expect(mocks.structure.mock.calls[0][1]).toEqual(['https://storage.example/owned-signed-image'])
    expect((await POST(request({ ...body, ...photos, photo_urls: ['https://rotated.example'] }))).status).toBe(200)
    expect(mocks.structure).toHaveBeenCalledTimes(1)
    const intake = (await db.query<{ scope: { specs: { supplied_by: string } }; inspection_required: boolean }>('select scope, inspection_required from intakes')).rows[0]
    expect(intake.scope.specs.supplied_by).toBe('customer'); expect(intake.inspection_required).toBe(true)
  })

  it('fails closed without a durable claim; controlled pre-intake failure permits only a new operation', async () => {
    failClaim = true
    expect((await POST(request())).status).toBe(503); expect(mocks.structure).not.toHaveBeenCalled()
    failClaim = false; mocks.structure.mockRejectedValueOnce(new Error('provider unavailable'))
    expect(await (await POST(request())).json()).toMatchObject({ status: 'failed_no_commit' })
    expect(await (await POST(request())).json()).toMatchObject({ status: 'failed_no_commit' })
    expect(mocks.structure).toHaveBeenCalledTimes(1)
    expect((await db.query('select * from intakes')).rows).toHaveLength(0)
  })

  it.each([[null, false], ['', false], [' ', false], ['not a price', false], ['-1', false], ['0', true], ['12.35', true]] as const)(
    'pinned price %s retains explicit zero but never guesses missing/invalid catalogue prices', async (price, pinned) => {
      const productId = 'cccccccc-1111-4111-8111-cccccccccccc'
      await db.query('insert into tenant_material_catalogue(id,tenant_id,name,unit_price_ex_gst,category,trade,active) values($1,$2,$3,$4,$5,$6,true)', [productId, A, 'EV product', price, 'ev_charger', 'electrical'])
      const response = await POST(request({ ...body, answers: { ...body.answers, charger_supply: 'we supply the charger' }, product_id: productId }))
      expect(await response.json()).toMatchObject({ status: 'completed', pinned, pinRequested: true })
      const intake = (await db.query<{ scope: { chosen_product?: { price_ex_gst: number } } }>('select scope from intakes')).rows[0]
      if (pinned) expect(intake.scope.chosen_product?.price_ex_gst).toBe(Number(price))
      else expect(intake.scope.chosen_product).toBeUndefined()
    },
  )

  it('an ambiguous intake INSERT acknowledgement never unlocks or dispatches a duplicate', async () => {
    failIntakeResponse = true
    expect(await (await POST(request())).json()).toMatchObject({ status: 'unknown' })
    expect(await (await POST(request())).json()).toMatchObject({ status: 'unknown' })
    expect((await db.query('select * from intakes')).rows).toHaveLength(1)
    expect(mocks.structure).toHaveBeenCalledTimes(1); expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('queued or lost estimate responses recover saved availability, then only a durable completion proves completion', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ ok: true, jobId: 'queued' }, { status: 202 }))
    expect(await (await POST(request())).json()).toMatchObject({ status: 'processing' })
    const { intake_id } = await receipt()
    await saveQuote(intake_id)
    expect(await (await status()).json()).toMatchObject({ status: 'quote_available', quoteId: Q })
    await db.query('insert into sms_work_jobs values($1,$2,$3,$4)', [`estimate:initial:${intake_id}`, 'estimate', 'completed', { status: 200, body: JSON.stringify({ ok: true, quoteId: Q }) }])
    expect(await (await status()).json()).toMatchObject({ status: 'completed', quoteId: Q })
    expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.structure).toHaveBeenCalledTimes(1)
  })

  it('crashed claims stay unknown after the request budget and neither GET nor replay reclaims them', async () => {
    await mocks.client.rpc('claim_job_quote_operation', { p_tenant_id: A, p_operation_id: OP, p_request_hash: jobQuoteRequestHash(input), p_pin_requested: false })
    await db.exec("alter table job_quote_operations disable trigger job_quote_operation_identity; update job_quote_operations set created_at=now()-interval '1 hour'; alter table job_quote_operations enable trigger job_quote_operation_identity")
    expect(await (await status()).json()).toMatchObject({ status: 'unknown' })
    expect(await (await POST(request())).json()).toMatchObject({ status: 'unknown' })
    expect(mocks.structure).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('saved rows cannot assert success for foreign quotes or mismatched worker results', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ ok: true, jobId: 'queued' }, { status: 202 }))
    await POST(request()); const { intake_id } = await receipt()
    await saveQuote(intake_id, B)
    expect(await (await status()).json()).not.toHaveProperty('quoteId')
    await db.query('update quotes set tenant_id=$1', [A])
    await db.query('insert into sms_work_jobs values($1,$2,$3,$4)', [`estimate:initial:${intake_id}`, 'estimate', 'completed', { status: 200, body: JSON.stringify({ ok: true, quoteId: 'wrong' }) }])
    expect(await (await status()).json()).toMatchObject({ status: 'quote_available' })
  })

  it('anon/authenticated cannot read or claim service-owned receipts', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`)
      await expect(db.query('select * from job_quote_operations')).rejects.toThrow(/permission denied/)
      await expect(db.query('select claim_job_quote_operation($1,$2,$3,false)', [A, OP, 'a'.repeat(64)])).rejects.toThrow(/permission denied/)
      await db.exec('reset role')
    }
  })
})

it('hashes canonical ordered answers and exact durable media, never capability URLs', () => {
  expect(jobQuoteRequestHash(input)).toBe(jobQuoteRequestHash({ ...input, answers: { phase: input.answers.phase, charger_supply: input.answers.charger_supply }, photo_urls: ['anything'] }))
  expect(jobQuoteRequestHash(input)).not.toBe(jobQuoteRequestHash({ ...input, photo_paths: [path] }))
  expect(validJobQuoteMedia(A, { photo_paths: [path + '/../../secret'] })).toBe(false)
})

describe('owner action readiness combines portal receipts and estimate worker outcomes', () => {
  const intakeId = 'ffffffff-1111-4111-8111-ffffffffffff'
  const quote = { id: Q, tenant_id: A, intake_id: intakeId }
  it('legacy records without operation/worker history are ready, but a pending worker still blocks them', async () => {
    expect(await readQuoteDraftReadiness(mocks.client, quote)).toEqual({ ready: true })
    await db.query('insert into sms_work_jobs values($1,$2,$3,null)', [`estimate:initial:${intakeId}`, 'estimate', 'running'])
    expect(await readQuoteDraftReadiness(mocks.client, quote)).toEqual({ ready: false, code: 'quote_draft_processing' })
    await db.query('update sms_work_jobs set status=$1,result=$2', ['completed', { status: 200, body: JSON.stringify({ ok: true, quoteId: Q }) }])
    expect(await readQuoteDraftReadiness(mocks.client, quote)).toEqual({ ready: true })
  })
  it('a saved quote from an incomplete operation stays read-only until exact worker completion', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ ok: true }, { status: 202 }))
    await POST(request()); const { intake_id } = await receipt(); await saveQuote(intake_id)
    const owned = { ...quote, intake_id }
    expect(await readQuoteDraftReadiness(mocks.client, owned)).toEqual({ ready: false, code: 'quote_draft_processing' })
    await db.query('insert into sms_work_jobs values($1,$2,$3,$4)', [`estimate:initial:${intake_id}`, 'estimate', 'completed', { status: 200, body: JSON.stringify({ ok: true, quoteId: Q }) }])
    expect(await readQuoteDraftReadiness(mocks.client, owned)).toEqual({ ready: true })
  })
  it('a completed operation is ready but contradictory active work or different quote identity fails closed', async () => {
    await POST(request()); const { intake_id } = await receipt()
    expect(await readQuoteDraftReadiness(mocks.client, { ...quote, intake_id })).toEqual({ ready: true })
    expect(await readQuoteDraftReadiness(mocks.client, { ...quote, intake_id: intakeId })).toEqual({ ready: false, code: 'quote_draft_unconfirmed' })
    await db.query('insert into sms_work_jobs values($1,$2,$3,null)', [`estimate:initial:${intake_id}`, 'estimate', 'running'])
    expect(await readQuoteDraftReadiness(mocks.client, { ...quote, intake_id })).toEqual({ ready: false, code: 'quote_draft_processing' })
  })
  it.each(['{"ok":true,"quoteId":"other"}', 'not JSON', '{"ok":false}'])('does not treat an invalid completed worker body as success: %s', async result => {
    await db.query('insert into sms_work_jobs values($1,$2,$3,$4)', [`estimate:initial:${intakeId}`, 'estimate', 'completed', { status: 200, body: result }])
    expect(await readQuoteDraftReadiness(mocks.client, quote)).toEqual({ ready: false, code: 'quote_draft_unconfirmed' })
  })
  it('database lookup failures and unscoped/malformed identifiers never unlock owner actions', async () => {
    expect(await readQuoteDraftReadiness(mocks.client, { ...quote, tenant_id: null })).toEqual({ ready: false, code: 'quote_draft_unconfirmed' })
    const failing = { from: () => { throw new Error('database unavailable') } } as unknown as SupabaseClient
    expect(await readQuoteDraftReadiness(failing, quote)).toEqual({ ready: false, code: 'quote_draft_unconfirmed' })
  })
  it('final/balance children resolve their owned initial root rather than compare their ID to the initial worker result', async () => {
    await POST(request()); const { intake_id } = await receipt()
    const child = { id: 'cccccccc-1111-4111-8111-cccccccccccc', tenant_id: A, intake_id, quote_kind: 'final' }
    expect(await readQuoteDraftReadiness(mocks.client, child)).toEqual({ ready: true })
    expect(await readQuoteDraftReadiness(mocks.client, { ...child, quote_kind: 'balance' })).toEqual({ ready: true })
    await db.query('insert into sms_work_jobs values($1,$2,$3,null)', [`estimate:initial:${intake_id}`, 'estimate', 'running'])
    expect(await readQuoteDraftReadiness(mocks.client, child)).toEqual({ ready: false, code: 'quote_draft_processing' })
    expect(await readQuoteDraftReadiness(mocks.client, { ...child, tenant_id: B })).toEqual({ ready: false, code: 'quote_draft_unconfirmed' })
  })
})
