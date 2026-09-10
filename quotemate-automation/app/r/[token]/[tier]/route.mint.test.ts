import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest'
import { MINT_QUOTE_FIELDS } from '@/lib/quote/mint-authority'

const mocks = vi.hoisted(() => ({ client: {} as SupabaseClient, create: vi.fn(), retrieve: vi.fn(), expire: vi.fn(), connect: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => new Proxy({}, { get: (_, key) => Reflect.get(mocks.client, key) }) }))
vi.mock('@/lib/stripe/client', () => ({ getStripe: () => ({ checkout: { sessions: { create: mocks.create, retrieve: mocks.retrieve, expire: mocks.expire } } }) }))
vi.mock('@/lib/stripe/connect', async original => ({ ...await original<typeof import('@/lib/stripe/connect')>(), connectDestinationForTenantId: mocks.connect }))
vi.mock('@/lib/quote/slots', async original => ({ ...await original<typeof import('@/lib/quote/slots')>(), resolveBookingOptions: () => [{}] }))
import { GET } from './route'

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const Q = 'cccccccc-1111-4111-8111-cccccccccccc'
const I = 'dddddddd-1111-4111-8111-dddddddddddd'
const ROOT = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee'
const FINAL = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const BOOK = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'
const VERSION = 'ffffffff-1111-4111-8111-ffffffffffff'
type Row = Record<string, unknown>
let db: PGlite
let sessions: Map<string, Row>
let serial: number
let failUpdate: boolean
let failRead: boolean
let failTradeProbe: 'error' | 'missing' | null
let failParentRead: boolean
let loseAck: boolean
let afterCreate: (() => Promise<unknown>) | null
const calls: Array<{ table: string; action: string; filters: Array<[string, string, unknown]> }> = []

function adapter(): SupabaseClient {
  return { from: (table: string) => {
    let columns = '*'; let action = 'select'; let update: Row = {}; let single = false; let limit: number | null = null
    const filters: Array<[string, string, unknown]> = []
    let or: string | null = null
    const query = {
      select: (value: string) => { columns = value; return query },
      eq: (key: string, value: unknown) => { filters.push([key,'eq',value]); return query },
      is: (key: string, value: unknown) => { filters.push([key,'is',value]); return query },
      not: (key: string, op: string, value: unknown) => { filters.push([key,`not-${op}`,value]); return query },
      neq: (key: string, value: unknown) => { filters.push([key,'neq',value]); return query },
      in: (key: string, value: unknown) => { filters.push([key,'in',value]); return query },
      or: (value: string) => { or = value; return query },
      order: () => query,
      limit: (value: number) => { limit = value; return query },
      update: (value: Row) => { action = 'update'; update = value; return query },
      maybeSingle: () => { single = true; return query }, single: () => { single = true; return query },
      then: (ok: (value: unknown) => unknown, fail: (error: unknown) => unknown) => run().then(ok, fail),
    }
    async function run() {
      calls.push({ table, action, filters })
      if (table === 'intakes' && columns === 'trade' && failTradeProbe) {
        return { data: null, error: failTradeProbe === 'error' ? { message:'transient trade read failure' } : null }
      }
      if (table === 'quotes' && action === 'select' && failParentRead && columns.includes('paid_tier') && filters.some(([key,,value]) => key === 'id' && value !== Q)) {
        return { data:null,error:{message:'parent lookup failed'} }
      }
      if ((failRead && action === 'select' && table === 'quotes') || (failUpdate && action === 'update')) return { data: null, error: { message: 'database unavailable' } }
      try {
        const values: unknown[] = []
        const bind = (value: unknown) => { values.push(value); return `$${values.length}` }
        const where = filters.map(([key,op,value]) => value === null ? `${key} is ${op === 'not-is' ? 'not ' : ''}null`
          : op === 'in' ? `${key}=any(${bind(value)})` : `${key}${op === 'neq' ? '<>' : '='}${bind(value)}`)
        if (or) where.push(`(${or.split(',').map(part => { const [key,,value] = part.split('.'); return `${key}=${bind(value)}` }).join(' or ')})`)
        const assignments = action === 'update' ? Object.entries(update).map(([key,value]) => `${key}=${bind(value)}`).join(',') : ''
        let sql = action === 'update' ? `update ${table} set ${assignments}` : `select ${columns} from ${table}`
        if (where.length) sql += ` where ${where.join(' and ')}`
        if (action === 'update') sql += ` returning ${columns}`
        else if (limit) sql += ` limit ${limit}`
        const result = await db.query(sql, values)
        // JSON serialization emulates PostgREST's timestamp and numeric payloads.
        const rows = JSON.parse(JSON.stringify(result.rows)) as Row[]
        for (const row of rows) for (const key of ['total_inc_gst','deposit_pct','applied_discount_pct','early_bird_discount_pct']) {
          if (typeof row[key] === 'string') row[key] = Number(row[key])
        }
        if (loseAck && action === 'update') return { data: null, error: { message: 'lost write response' } }
        return { data: single ? rows[0] ?? null : rows, error: null }
      } catch (error) { return { data: null, error } }
    }
    return query
  } } as unknown as SupabaseClient
}
beforeAll(async () => {
  db = new PGlite()
  const type = (key: string) => ['id','tenant_id','intake_id','parent_quote_id','pricing_book_version_id'].includes(key) ? 'uuid'
    : ['good','better','best','report_doc','report_style','stripe_links','risk_flags'].includes(key) ? 'jsonb'
      : key.endsWith('_at') || key.endsWith('_until') ? 'timestamptz'
        : key === 'needs_inspection' ? 'boolean' : ['total_inc_gst','deposit_pct','applied_discount_pct','early_bird_discount_pct'].includes(key) ? 'numeric' : 'text'
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table tenants(id uuid primary key, available_slots jsonb,default_availability jsonb,state text);
    create table quotes(${MINT_QUOTE_FIELDS.map(key => `${key} ${type(key)} ${key === 'id' ? 'primary key' : ''}`).join(',')},booking_state text,scheduled_window text);
    create table intakes(id uuid primary key,tenant_id uuid,job_type text,scope jsonb,caller jsonb,trade text);
    create table pricing_book(id uuid,tenant_id uuid,trade text,gst_registered boolean);
    create table quote_pricing_versions(id uuid,tenant_id uuid,trade text,pricing_book_id uuid,snapshot jsonb,content_hash text);
    create table sms_work_jobs(work_key text,kind text,status text,result jsonb);
    insert into tenants(id) values('${A}');`)
  await db.exec(readFileSync(resolve(process.cwd(), 'sql/migrations/202_job_quote_operations.sql'), 'utf8'))
  mocks.client = adapter()
}, 60_000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  await db.exec('truncate quotes,job_quote_operations,intakes,pricing_book,quote_pricing_versions,sms_work_jobs cascade')
  await db.query("insert into quotes(id,tenant_id,intake_id,status,quote_kind,share_token,customer_released_at,created_at,price_hold_until,total_inc_gst,deposit_pct,selected_tier,good) values($1,$2,$3,'draft','initial','token',now(),now(),'2099-01-01',1100,50,'good',$4)", [Q,A,I,{ subtotal_ex_gst:1000,line_items:[{description:'Work',quantity:1,unit_price_ex_gst:1000,total_ex_gst:1000}] }])
  await db.query("insert into intakes values($1,$2,'roof_work','{}','{}','roofing')", [I,A])
  await db.query("insert into pricing_book values($1,$2,'roofing',true)", [BOOK,A])
  vi.clearAllMocks(); vi.stubEnv('APP_URL','https://quote.example')
  sessions = new Map(); serial = 0; failUpdate = false; failRead = false; failTradeProbe = null; failParentRead = false; loseAck = false; afterCreate = null; calls.length = 0
  mocks.connect.mockResolvedValue({ accountId:'acct_fixture' })
  mocks.create.mockImplementation(async (input: Row) => {
    const id = `cs_test_candidate${++serial}`
    const row = { id, status:'open', payment_status:'unpaid', metadata:input.metadata, url:`https://checkout.stripe.com/c/pay/${id}` }
    sessions.set(id,row)
    await afterCreate?.()
    return row
  })
  mocks.retrieve.mockImplementation(async (id: string) => { if (!sessions.has(id)) throw new Error('missing'); return sessions.get(id) })
  mocks.expire.mockImplementation(async (id: string) => { const row = { ...sessions.get(id),status:'expired' }; sessions.set(id,row); return row })
})
function mint(tier = 'inspection') { return GET(new NextRequest(`https://quote.example/r/token/${tier}`), { params:Promise.resolve({token:'token',tier}) }) }
async function row() { return (await db.query<Row>('select * from quotes where id=$1',[Q])).rows[0] }
const unavailable = (response: Response) => expect(response.headers.get('location')).toBe('https://quote.example/q/token?pay=unavailable')
async function setupChild(kind:'final'|'balance') {
  await db.exec("update intakes set trade='electrical'")
  await db.query("insert into quotes(id,tenant_id,intake_id,quote_kind,paid_at,paid_tier) values($1,$2,$3,'initial',now(),'inspection')",[ROOT,A,I])
  if (kind === 'balance') await db.query("insert into quotes(id,tenant_id,intake_id,quote_kind,parent_quote_id,sent_at,paid_at,paid_tier,total_inc_gst,deposit_pct) values($1,$2,$3,'final',$4,now(),now(),'deposit',1100,50)",[FINAL,A,I,ROOT])
  await db.query('update quotes set quote_kind=$1,parent_quote_id=$2,total_inc_gst=$3 where id=$4',[kind,kind === 'final' ? ROOT : FINAL,kind === 'final' ? 1100 : 550,Q])
}

describe('generic payment mint, actual GET + PostgreSQL writes + mocked Stripe boundary', () => {
  it('persists and returns a confirmed new inspection session with exact quote identity', async () => {
    const response = await mint()
    expect(response.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_candidate1')
    expect((await row()).stripe_links).toEqual({inspection:response.headers.get('location')})
    expect(mocks.create.mock.calls[0][0].metadata).toMatchObject({quote_id:Q,tier:'inspection'})
    const write = calls.find(call => call.action === 'update')!
    expect(write.filters).toContainEqual(['tenant_id','eq',A]); expect(write.filters).toContainEqual(['paid_at','is',null])
    expect(write.filters).toContainEqual(['good','eq',expect.any(String)])
  })
  it.each(['held','processing','unknown-kind','unscoped'])('blocks %s before provider creation', async kind => {
    if (kind === 'held') await db.exec('update quotes set customer_released_at=null')
    if (kind === 'processing') await db.query("insert into sms_work_jobs values($1,'estimate','running',null)",[`estimate:initial:${I}`])
    if (kind === 'unknown-kind') await db.exec("update quotes set quote_kind='future'")
    if (kind === 'unscoped') await db.exec('update quotes set tenant_id=null')
    unavailable(await mint()); expect(mocks.create).not.toHaveBeenCalled()
  })
  it.each(['sent','paid'])('preserves the shared legacy %s release predicate', async state => {
    await db.exec(`update quotes set customer_released_at=null,${state === 'paid' ? 'paid_at=now()' : 'sent_at=now()'}`)
    const response = await mint()
    if (state === 'paid') { expect(response.headers.get('location')).toContain('/paid?'); expect(mocks.create).not.toHaveBeenCalled() }
    else expect(response.headers.get('location')).toContain('checkout.stripe.com')
  })
  it.each(['database-error','deleted','paid','changed-price','lost-ack'])('cancels the unexposed candidate after %s and never falls back to a stored URL', async kind => {
    const old = { id:'cs_test_old',status:'expired',payment_status:'unpaid',metadata:{quote_id:Q},url:'https://checkout.stripe.com/c/pay/cs_test_old' }
    sessions.set('cs_test_old',old)
    await db.query('update quotes set stripe_links=$1',[{inspection:old.url}])
    if (kind === 'database-error') failUpdate = true
    if (kind === 'lost-ack') loseAck = true
    if (kind === 'deleted') afterCreate = () => db.exec('delete from quotes')
    if (kind === 'paid') afterCreate = () => db.exec('update quotes set paid_at=now()')
    if (kind === 'changed-price') afterCreate = () => db.exec('update quotes set total_inc_gst=1200')
    unavailable(await mint())
    expect(sessions.get('cs_test_candidate1')?.status).toBe('expired')
  })
  it('does not expose a candidate when cancellation fails and retains its quote', async () => {
    failUpdate = true; mocks.expire.mockRejectedValue(new Error('provider unavailable'))
    unavailable(await mint()); expect(await row()).toBeDefined()
  })
  it.each(['open','expired','complete','foreign'])('checks the %s replaced checkout before publishing a new one', async state => {
    const old = {id:'cs_test_old',status:state === 'foreign' ? 'open' : state,payment_status:'unpaid',metadata:{quote_id:state === 'foreign' ? ROOT : Q}}
    sessions.set('cs_test_old',old)
    await db.query('update quotes set stripe_links=$1',[{inspection:'https://checkout.stripe.com/c/pay/cs_test_old'}])
    const response = await mint()
    if (state === 'open' || state === 'expired') expect(response.headers.get('location')).toContain('cs_test_candidate1')
    else { unavailable(response); expect(sessions.get('cs_test_candidate1')?.status).toBe('expired') }
  })
  it('lets only one simultaneous candidate win the same stored-link snapshot', async () => {
    let waiting: (() => void) | null = null
    afterCreate = async () => { if (serial === 1) await new Promise<void>(resolve => { waiting = resolve }); else waiting?.() }
    const results = await Promise.all([mint(),mint()])
    expect(results.filter(result => result.headers.get('location')?.includes('checkout.stripe.com'))).toHaveLength(1)
    expect([...sessions.values()].filter(session => session.status === 'open')).toHaveLength(1)
  })
  it('uses historical GST and exact stored deposit percentage despite current-book changes', async () => {
    await db.query('insert into quote_pricing_versions values($1,$2,$3,$4,$5,$6)',[VERSION,A,'roofing',BOOK,{id:BOOK,tenant_id:A,trade:'roofing',gst_registered:true},'a'.repeat(64)])
    await db.query('update quotes set pricing_book_version_id=$1',[VERSION])
    await db.exec('update pricing_book set gst_registered=false')
    const response = await mint('good')
    expect(response.headers.get('location')).toContain('checkout.stripe.com')
    expect(mocks.create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(55000)
    expect(calls.some(call => call.table === 'pricing_book')).toBe(false)
  })
  it.each(['error','missing'] as const)('blocks an initial %s trade probe before any electrical G/B/B checkout', async failure => {
    await db.exec("update intakes set trade='electrical'; update pricing_book set trade='electrical'")
    failTradeProbe = failure
    unavailable(await mint('good')); expect(mocks.create).not.toHaveBeenCalled()
    failTradeProbe = null
    expect((await mint('good')).headers.get('location')).toBe('https://quote.example/r/token/inspection')
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it.each(['missing-book','unknown-tax','invalid-deposit','missing-version'])('blocks priced tier with %s before provider work', async kind => {
    if (kind === 'missing-book') await db.exec('delete from pricing_book')
    if (kind === 'unknown-tax') await db.exec('update quotes set total_inc_gst=1234')
    if (kind === 'invalid-deposit') await db.exec('update quotes set deposit_pct=null')
    if (kind === 'missing-version') await db.query('update quotes set pricing_book_version_id=$1',[VERSION])
    unavailable(await mint('good')); expect(mocks.create).not.toHaveBeenCalled()
  })
  it('requires the discounted quote stamp to commit before creating a discounted checkout', async () => {
    await db.exec("update quotes set early_bird_discount_pct=10,early_bird_expires_at='2099-01-01'")
    failUpdate = true
    unavailable(await mint('good')); expect(mocks.create).not.toHaveBeenCalled()
    failUpdate = false
    expect((await mint('good')).headers.get('location')).toContain('checkout.stripe.com')
    expect((await row()).applied_discount_pct).toBe('10')
    expect(mocks.create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(49500)
  })
  it.each(['final','balance'] as const)('requires acknowledged %s child link without changing its stored money calculation', async kind => {
    await setupChild(kind)
    failUpdate = true
    unavailable(await mint(kind === 'final' ? 'deposit' : 'balance'))
    expect(sessions.get('cs_test_candidate1')?.status).toBe('expired')
  })
  it.each(['final','balance'] as const)('charges a proven %s chain once with matching canonical fee', async kind => {
    await setupChild(kind)
    const response = await mint(kind === 'final' ? 'deposit' : 'balance')
    expect(response.headers.get('location')).toContain('checkout.stripe.com')
    const input = mocks.create.mock.calls[0][0]
    expect(input.line_items.map((line: {price_data:{unit_amount:number}}) => line.price_data.unit_amount)).toEqual(kind === 'final' ? [45100,902] : [55000,1100])
    expect(input.metadata).toMatchObject({quote_id:Q,tier:kind === 'final' ? 'deposit' : 'balance'})
  })
  it.each(['unpaid-inspection','wrong-inspection-tier','foreign-root','different-intake','final-unsent','final-unpaid','wrong-deposit-tier','inconsistent-balance','inconsistent-percent'])('rejects %s history before creating a balance payment', async state => {
    await setupChild('balance')
    if (state === 'unpaid-inspection') await db.query('update quotes set paid_at=null where id=$1',[ROOT])
    if (state === 'wrong-inspection-tier') await db.query("update quotes set paid_tier='good' where id=$1",[ROOT])
    if (state === 'foreign-root') await db.query('update quotes set tenant_id=$1 where id=$2',[FINAL,ROOT])
    if (state === 'different-intake') await db.query('update quotes set intake_id=$1 where id=$2',[ROOT,FINAL])
    if (state === 'final-unsent') await db.query('update quotes set sent_at=null where id=$1',[FINAL])
    if (state === 'final-unpaid') await db.query('update quotes set paid_at=null where id=$1',[FINAL])
    if (state === 'wrong-deposit-tier') await db.query("update quotes set paid_tier='inspection' where id=$1",[FINAL])
    if (state === 'inconsistent-balance') await db.query('update quotes set total_inc_gst=650 where id=$1',[Q])
    if (state === 'inconsistent-percent') await db.query('update quotes set deposit_pct=30 where id=$1',[Q])
    const response = await mint('balance')
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ok:false,error:'quote_chain_not_payable'})
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('returns 503 for unavailable parent evidence before provider creation', async () => {
    await setupChild('final'); failParentRead = true
    const response = await mint('deposit')
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ok:false,error:'quote_chain_unavailable'})
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('fails a database lookup without provider work', async () => {
    failRead = true
    expect((await mint()).status).toBe(503); expect(mocks.create).not.toHaveBeenCalled()
  })
})
