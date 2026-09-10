import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { calculatePaintPricing, paintLabourIntent, parsePaintPricingSource, verifyPaintPricing, type PaintPricingSource } from './pricing-proof'
import { buildPaintQuotePayloads } from './save-quote-helpers'
import { commercialPaintSaveIdentity, normalisePaintPricedAt } from './saved-quote'

const handlerIo = vi.hoisted(() => ({ tenant: '', client: {} as Record<string, unknown>,
  beforeSave: null as (() => Promise<void>) | null, loseSaveAcknowledgement: false }))
vi.mock('@/lib/estimation/auth', () => ({ tenantFromBearer: async () => handlerIo.tenant ? { id: handlerIo.tenant } : null,
  estimatorSupabase: { from: (...args: unknown[]) => (handlerIo.client.from as (...args: unknown[]) => unknown)(...args),
    rpc: (...args: unknown[]) => (handlerIo.client.rpc as (...args: unknown[]) => unknown)(...args) } }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: vi.fn(async () => handlerIo.tenant
  ? { identity: { userId: `fixture-user:${handlerIo.tenant}` }, tenant: { id: handlerIo.tenant } } : null) }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ storage: {} }) }))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@/lib/pdf/gotenberg', () => ({ gotenbergConfigured: () => false, renderPdfFromHtml: vi.fn() }))
vi.mock('@/lib/pdf/branding', () => ({ loadTenantBranding: async () => ({ businessName: 'Fixture Painting' }) }))
vi.mock('@/lib/filestore/ingest-quote', () => ({ archiveAndIngestQuote: vi.fn() }))
vi.mock('@/lib/filestore/minimize', () => ({ buildQuoteKbText: vi.fn() }))
vi.mock('@/lib/filestore/provision', () => ({ provisionSessionStore: vi.fn() }))
vi.mock('@/lib/stripe/checkout', () => ({ generateShareToken: () => `fixture-${Math.random()}` }))
vi.mock('@/lib/log/pipeline', () => ({ pipelineLog: () => ({ ok: vi.fn(), err: vi.fn() }) }))
import { POST as priceHandler } from '@/app/api/tenant/commercial-painting/price/route'
import { POST as saveHandler, GET as saveStatusHandler } from '@/app/api/tenant/commercial-painting/save-quote/route'

const item = { surface: 'Internal walls', room: 'Retail', substrate: 'plasterboard', system: 'low_sheen',
  unit: 'm2', quantity: 100, coats: 2, confidence: 'high', source: 'plan' }
const rates = [
  { kind: 'labour', code: 'labour:low_sheen:roller', label: 'Labour', system: 'low_sheen', method: 'roller', coverage_m2_per_hr: 10 },
  { kind: 'material', code: 'mat:wall_low_sheen', label: 'Paint', system: 'low_sheen', product: 'Low sheen', spread_m2_per_l: 15, price_per_l_ex_gst: 11 },
  ...Object.entries({ height_low: 1, height_mid: 1.25, height_high: 1.4, prep_pct: 0.1, sundries_pct: 0.08,
    labour_rate: 95, crew_hours_per_day: 7.6, default_crew_size: 3 }).map(([key, value]) => ({ kind: 'modifier', code: `mod:${key}`, label: key, value })),
]
let pg: PGlite
let tenant: string, run: string, extraction: string, book: string
beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`create role anon;create role authenticated;create role service_role;
    create table paint_runs(id uuid primary key,tenant_id uuid,job_name text,site_address text,status text,public_token text,released_at timestamptz,updated_at timestamptz);
    create table plan_extractions(id uuid primary key,tenant_id uuid,paint_run_id uuid,trade text default 'commercial_painting',items jsonb,corrected_items jsonb,sheets_used jsonb,priced_bom jsonb,priced_at timestamptz,created_at timestamptz default now(),updated_at timestamptz);
    create table paint_rates(id uuid primary key default gen_random_uuid(),trade text,tenant_id uuid,kind text,code text,label text,system text,method text,product text,coverage_m2_per_hr numeric,spread_m2_per_l numeric,price_per_l_ex_gst numeric,unit_hours numeric,value numeric,unit text,is_default boolean);
    create table pricing_book(id uuid primary key,tenant_id uuid,trade text,gst_registered boolean);
    create table intakes(id uuid primary key,tenant_id uuid,trade text,job_type text,address text,suburb text,scope jsonb,access jsonb,property jsonb,risks jsonb,inspection_required boolean,caller jsonb,timing jsonb,confidence text,confidence_reason text);
    create table quotes(id uuid primary key,tenant_id uuid,intake_id uuid references intakes(id),status text,share_token text,scope_of_works text,assumptions jsonb,risk_flags jsonb,needs_inspection boolean,inspection_reason text,good jsonb,better jsonb,best jsonb,selected_tier text,subtotal_ex_gst numeric,gst numeric,total_inc_gst numeric,routing_decision text,pdf_path text);`)
  await pg.exec(readFileSync('sql/migrations/211_commercial_quote_release_guard.sql', 'utf8'))
  await pg.exec(readFileSync('sql/migrations/219_commercial_paint_pricing_proof.sql', 'utf8'))
}, 30_000)
afterAll(async () => { await pg?.close() })
beforeEach(async () => {
  tenant = randomUUID(); run = randomUUID(); extraction = randomUUID(); book = randomUUID()
  handlerIo.tenant = tenant; handlerIo.beforeSave = null; handlerIo.loseSaveAcknowledgement = false
  handlerIo.client = {
    rpc: (name: string, args: Record<string, unknown> = {}) => ({ abortSignal: async () => {
      if (name === 'save_commercial_paint_quote' && handlerIo.beforeSave) await handlerIo.beforeSave()
      try {
        const pairs = Object.entries(args)
        const result = await pg.query<{ value: unknown }>(`select ${name}(${pairs.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) value`, pairs.map(([, value]) => value))
        if (name === 'save_commercial_paint_quote' && handlerIo.loseSaveAcknowledgement) return { data: null, error: { code: 'network_lost' } }
        return { data: result.rows[0].value, error: null }
      } catch (error) { return { data: null, error } }
    } }),
    from: (table: string) => {
      let fields = '*'; let patch: Record<string, unknown> | null = null
      const filters: Array<[string, unknown]> = []; const nulls: string[] = []
      const result = async () => {
        const entries = Object.entries(patch ?? {})
        const values = [...entries.map(([, value]) => value), ...filters.map(([, value]) => value)]
        const where = [...filters.map(([key], i) => `${key}=$${entries.length + i + 1}`), ...nulls.map(key => `${key} is null`)].join(' and ')
        try {
          const data = await pg.query<{ data: unknown }>(patch ? `with selected as (update ${table} set ${entries.map(([key], i) => `${key}=$${i + 1}`).join(',')} where ${where} returning ${fields}) select to_jsonb(selected) data from selected`
            : `select to_jsonb(selected) data from (select ${fields} from ${table}${where ? ` where ${where}` : ''}) selected`, values)
          return { data: data.rows[0]?.data ?? null, error: null }
        } catch (error) { return { data: null, error } }
      }
      const query = { select: (value: string) => { fields = value; return query },
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query },
        is: (key: string) => { nulls.push(key); return query }, update: (value: Record<string, unknown>) => { patch = value; return query },
        maybeSingle: result, then: (resolve: (value: unknown) => unknown) => result().then(resolve) }
      return query
    },
  }
  await pg.query('insert into paint_runs(id,tenant_id,job_name,site_address,status) values($1,$2,$3,$4,$5)', [run, tenant, 'Retail repaint', '1 Test St', 'ready'])
  await pg.query('insert into plan_extractions(id,tenant_id,paint_run_id,items) values($1,$2,$3,$4)', [extraction, tenant, run, JSON.stringify([item])])
  await pg.query('insert into pricing_book values($1,$2,$3,$4)', [book, tenant, 'commercial_painting', true])
  for (const row of rates) {
    const values = { id: randomUUID(), ...row, trade: 'commercial_painting', tenant_id: tenant, is_default: false }
    await pg.query('insert into paint_rates select * from jsonb_populate_record(null::paint_rates,$1)', [JSON.stringify(values)])
  }
})
async function source(): Promise<PaintPricingSource> {
  const result = await pg.query<{ value: unknown }>('select commercial_paint_pricing_source($1,$2,$3) value', [tenant, run, extraction])
  return parsePaintPricingSource(result.rows[0].value, tenant, run, extraction)
}
async function price(src: PaintPricingSource, override?: number | null) {
  const calculated = calculatePaintPricing(src, paintLabourIntent(override))
  const result = await pg.query<{ value: { priced_at: string } }>('select persist_commercial_paint_pricing($1,$2,$3,$4,$5,$6) value',
    [tenant, run, extraction, src, calculated.proof, calculated.bom])
  return { ...calculated, pricedAt: result.rows[0].value.priced_at }
}
type Priced = Awaited<ReturnType<typeof price>>
function candidate(priced: Priced) {
  const ids = commercialPaintSaveIdentity(tenant, run, extraction, priced.pricedAt)
  const payload = buildPaintQuotePayloads({ tenantId: tenant, bom: priced.bom, shareToken: randomUUID(), jobName: 'Retail repaint', siteAddress: '1 Test St' })
  return { intake: { ...payload.intake, id: ids.intakeId, scope: { ...payload.intake.scope,
    paint_run_id: run, extraction_id: extraction, priced_at: priced.pricedAt, paint_pricing_proof: priced.proof } },
    quote: { ...payload.quote, id: ids.quoteId, intake_id: ids.intakeId } }
}
async function save(priced: Priced, payload = candidate(priced)) {
  const result = await pg.query<{ value: { ok: boolean; already: boolean; quote: { id: string; total_inc_gst: number; status: string } } }>(
    'select save_commercial_paint_quote($1,$2,$3,$4,$5,$6,$7,$8,$9) value',
    [tenant, run, extraction, priced.proof.source, priced.proof, priced.bom, priced.pricedAt, payload.intake, payload.quote])
  return result.rows[0].value
}

describe('commercial painting reviewed calculation provenance', () => {
  it.each([false, true])('round-trips an exact calculation and saved quote with GST=%s', async gst => {
    await pg.query('update pricing_book set gst_registered=$1 where id=$2', [gst, book])
    const src = await source(); const result = await price(src)
    expect(result.bom.gstRegistered).toBe(gst)
    expect(verifyPaintPricing(src, result.proof, result.bom, result.proof.digest).bom).toEqual(result.bom)
    const saved = await save(result)
    expect(saved.quote.status).toBe('draft')
    expect(Number(saved.quote.total_inc_gst)).toBe(result.bom.totalIncGst)
    const reloaded = await pg.query<{ scope: { paint_pricing_proof: unknown } }>('select scope from intakes where id=(select intake_id from quotes where id=$1)', [saved.quote.id])
    expect(reloaded.rows[0].scope.paint_pricing_proof).toEqual(result.proof)
  })
  it.each([undefined, 125])('underlying labour rate changes invalidate %s pricing even with an intentional override', async override => {
    const original = await price(await source(), override)
    await pg.query("update paint_rates set value=150 where tenant_id=$1 and code='mod:labour_rate'", [tenant])
    const current = await source()
    expect(() => verifyPaintPricing(current, original.proof, original.bom, original.proof.digest)).toThrow('pricing_changed')
    await expect(save(original)).rejects.toMatchObject({ code: 'QP001' })
    const next = await price(current, override)
    expect(next.bom.labour.ratePerHr).toBe(override ?? 150)
  })
  it('keeps an explicit override distinct from an equal inherited value', async () => {
    const src = await source()
    const inherited = calculatePaintPricing(src, paintLabourIntent(undefined))
    const intentional = calculatePaintPricing(src, paintLabourIntent(95))
    expect(inherited.bom).toEqual(intentional.bom)
    expect(inherited.proof.digest).not.toBe(intentional.proof.digest)
  })
  it.each([0, -1, 1001, '95', '', false, NaN, Infinity, 0.001])('rejects an invalid supplied labour override %j', value => {
    expect(() => paintLabourIntent(value)).toThrow('invalid_labour_rate')
  })
  it('rejects a foreign source and never uses a different trade GST book', async () => {
    const src = await source()
    expect(() => parsePaintPricingSource(src, randomUUID(), run, extraction)).toThrow('pricing_source_unavailable')
    await pg.query("update pricing_book set trade='electrical' where id=$1", [book])
    expect(() => calculatePaintPricing({ ...src, pricing_book: null }, paintLabourIntent(undefined))).toThrow('tenant_pricing_required')
    expect((await source()).pricing_book).toBeNull()
  })
  it('requires a fresh reviewed digest and rejects legacy or altered proof', async () => {
    const src = await source(); const result = await price(src)
    expect(() => verifyPaintPricing(src, null, result.bom, result.proof.digest)).toThrow('pricing_proof_required')
    expect(() => verifyPaintPricing(src, result.proof, result.bom, 'a'.repeat(64))).toThrow('pricing_review_required')
    expect(() => verifyPaintPricing(src, result.proof, { ...result.bom, totalIncGst: 1 }, result.proof.digest)).toThrow('pricing_changed')
  })
})

describe('commercial painting actual SQL snapshot gates', () => {
  it.each(['takeoff', 'rate', 'GST', 'job', 'address', 'new extraction', 'new rate'])('rejects %s changing while calculation is in flight', async change => {
    const original = await source()
    if (change === 'takeoff') await pg.query('update plan_extractions set corrected_items=$1 where id=$2', [JSON.stringify([{ ...item, quantity: 200 }]), extraction])
    if (change === 'rate') await pg.query("update paint_rates set value=150 where tenant_id=$1 and code='mod:labour_rate'", [tenant])
    if (change === 'GST') await pg.query('update pricing_book set gst_registered=false where id=$1', [book])
    if (change === 'job') await pg.query("update paint_runs set job_name='New job' where id=$1", [run])
    if (change === 'address') await pg.query("update paint_runs set site_address='New address' where id=$1", [run])
    if (change === 'new extraction') await pg.query("insert into plan_extractions(id,tenant_id,paint_run_id,items,created_at) values($1,$2,$3,'[]',now()+interval '1 day')", [randomUUID(), tenant, run])
    if (change === 'new rate') await pg.query("insert into paint_rates(trade,tenant_id,kind,code,label,value,is_default) values('commercial_painting',$1,'equipment','equip:scissor_lift','Lift',100,false)", [tenant])
    await expect(price(original)).rejects.toMatchObject({ code: 'QP001' })
    expect((await pg.query<{ priced_bom: unknown }>('select priced_bom from plan_extractions where id=$1', [extraction])).rows[0].priced_bom).toBeNull()
  })
  it('rejects repricing and save after customer release under migration211', async () => {
    const original = await price(await source())
    await pg.query('update paint_runs set released_at=now() where id=$1', [run])
    await expect(price(original.proof.source)).rejects.toMatchObject({ code: 'QM001' })
    await expect(save(original)).rejects.toMatchObject({ code: 'QM001' })
  })
  it('recovers one already saved quote despite later rates changing', async () => {
    const original = await price(await source()); const payload = candidate(original)
    const first = await save(original, payload)
    await pg.query("update paint_rates set value=150 where tenant_id=$1 and code='mod:labour_rate'", [tenant])
    expect(await save(original, payload)).toMatchObject({ already: true, quote: { id: first.quote.id } })
    expect((await pg.query<{ n: number }>('select count(*)::int n from quotes where tenant_id=$1', [tenant])).rows[0].n).toBe(1)
  })
  it('rejects changed customer intent on recovery', async () => {
    const original = await price(await source()); const payload = candidate(original)
    await save(original, payload)
    payload.intake.caller.phone = '+61411222333'
    await expect(save(original, payload)).rejects.toMatchObject({ code: 'QP003' })
  })
  it('rejects an older calculation after a different labour intent wins', async () => {
    const src = await source(); const old = await price(src)
    const current = await price(src, 125)
    await expect(save(old)).rejects.toMatchObject({ code: 'QP001' })
    expect((await save(current)).ok).toBe(true)
  })
  it('rolls back the intake if quote insertion fails', async () => {
    const original = await price(await source()); const payload = candidate(original)
    await pg.exec('create unique index if not exists quotes_share_token_unique on quotes(share_token)')
    const other = await price(await source(), 125)
    const winner = candidate(other); await save(other, winner)
    // A fresh current pricing pass with a colliding random public token.
    const latest = await price(await source(), 150); const failing = candidate(latest)
    failing.quote.share_token = winner.quote.share_token
    await expect(save(latest, failing)).rejects.toMatchObject({ code: '23505' })
    expect((await pg.query<{ n: number }>('select count(*)::int n from intakes where id=$1', [failing.intake.id])).rows[0].n).toBe(0)
    expect(payload.quote.status).toBe('draft')
  })
  it('denies direct unauthenticated callers of all three RPCs', async () => {
    const result = await pg.query<{ allowed: boolean }>(`select has_function_privilege('anon','commercial_paint_pricing_source(uuid,uuid,uuid)','execute') or
      has_function_privilege('authenticated','persist_commercial_paint_pricing(uuid,uuid,uuid,jsonb,jsonb,jsonb)','execute') or
      has_function_privilege('authenticated','save_commercial_paint_quote(uuid,uuid,uuid,jsonb,jsonb,jsonb,timestamptz,jsonb,jsonb)','execute') allowed`)
    expect(result.rows[0].allowed).toBe(false)
  })
})

describe('actual commercial paint handlers through migration219', () => {
  const request = (extra: Record<string, unknown> = {}) => new Request('https://example.test/api/tenant/commercial-painting/price', {
    method: 'POST', body: JSON.stringify({ paintRunId: run, extractionId: extraction, ...extra }),
  })
  async function reviewed(override?: number) {
    const response = await priceHandler(request(override === undefined ? {} : { labourRatePerHr: override }))
    expect(response.status).toBe(200)
    return await response.json() as { pricingProof: string; pricedAt: string; bom: { labour: { ratePerHr: number } } }
  }
  it('prices, quietly saves, reopens, and recovers a lost save response as one draft', async () => {
    const priced = await reviewed()
    handlerIo.loseSaveAcknowledgement = true
    const lost = await saveHandler(request({ pricingProof: priced.pricingProof, pricedAt: priced.pricedAt, customerPhone: '0411222333', customerName: 'Sam' }))
    expect(lost.status).toBe(503)
    handlerIo.loseSaveAcknowledgement = false
    const recovered = await saveHandler(request({ pricingProof: priced.pricingProof, pricedAt: priced.pricedAt, customerPhone: '0411222333', customerName: 'Sam' }))
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({ alreadySaved: true, delivery: { attempted: false } })
    expect((await pg.query<{ n: number }>('select count(*)::int n from quotes where tenant_id=$1', [tenant])).rows[0].n).toBe(1)
  })
  it.each([undefined, 125])('blocks stale adopted labour through actual Save, override=%s', async override => {
    const priced = await reviewed(override)
    await pg.query("update paint_rates set value=150 where tenant_id=$1 and code='mod:labour_rate'", [tenant])
    const response = await saveHandler(request({ pricingProof: priced.pricingProof, pricedAt: priced.pricedAt }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'pricing_changed' })
    expect((await pg.query<{ n: number }>('select count(*)::int n from quotes where tenant_id=$1', [tenant])).rows[0].n).toBe(0)
    expect((await reviewed(override)).bom.labour.ratePerHr).toBe(override ?? 150)
  })
  it('blocks a late rate mutation between route verification and SQL save', async () => {
    const priced = await reviewed()
    handlerIo.beforeSave = async () => { await pg.query("update paint_rates set value=150 where tenant_id=$1 and code='mod:labour_rate'", [tenant]) }
    const response = await saveHandler(request({ pricingProof: priced.pricingProof, pricedAt: priced.pricedAt }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'pricing_changed' })
    expect((await pg.query<{ n: number }>('select count(*)::int n from intakes where tenant_id=$1', [tenant])).rows[0].n).toBe(0)
  })
  it('does not accept a stale screen or a missing review token', async () => {
    const first = await reviewed(); await reviewed(125)
    for (const proof of [undefined, first.pricingProof]) {
      const response = await saveHandler(request({ pricingProof: proof, pricedAt: first.pricedAt }))
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'pricing_review_required' })
    }
  })
  it('denies unauthenticated and foreign source use', async () => {
    handlerIo.tenant = ''
    expect((await priceHandler(request())).status).toBe(401)
    expect((await saveHandler(request())).status).toBe(401)
    handlerIo.tenant = randomUUID()
    expect((await priceHandler(request())).status).toBe(404)
    expect((await saveHandler(request())).status).toBe(404)
  })
  it.each([false, '95', 0, 1001])('rejects invalid labour input %j before persisting pricing', async value => {
    const response = await priceHandler(request({ labourRatePerHr: value }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_labour_rate' })
    expect((await pg.query<{ priced_bom: unknown }>('select priced_bom from plan_extractions where id=$1', [extraction])).rows[0].priced_bom).toBeNull()
  })
  it('rejects the old screen after an identical re-price with a new generation', async () => {
    const first = await reviewed(); const second = await reviewed()
    expect(first.pricingProof).toBe(second.pricingProof)
    expect(first.pricedAt).not.toBe(second.pricedAt)
    const rejected = await saveHandler(request({ pricingProof: first.pricingProof, pricedAt: first.pricedAt }))
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ error: 'pricing_review_required' })
    expect((await pg.query<{ n: number }>('select count(*)::int n from quotes where tenant_id=$1', [tenant])).rows[0].n).toBe(0)
  })
  it('recovers the original lost save after identical repricing without creating another draft', async () => {
    const first = await reviewed()
    handlerIo.loseSaveAcknowledgement = true
    expect((await saveHandler(request({ pricingProof: first.pricingProof, pricedAt: first.pricedAt, customerPhone: '0411222333' }))).status).toBe(503)
    handlerIo.loseSaveAcknowledgement = false
    const second = await reviewed()
    expect(first.pricingProof).toBe(second.pricingProof)
    const recovered = await saveHandler(request({ pricingProof: first.pricingProof, pricedAt: first.pricedAt, customerPhone: '0411222333' }))
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({ alreadySaved: true, delivery: { attempted: false } })
    expect((await pg.query<{ n: number }>('select count(*)::int n from quotes where tenant_id=$1', [tenant])).rows[0].n).toBe(1)
  })
  it('does not silently reuse a saved customer phone after the input is cleared', async () => {
    const first = await reviewed()
    expect((await saveHandler(request({ pricingProof: first.pricingProof, pricedAt: first.pricedAt, customerPhone: '0411222333' }))).status).toBe(200)
    const cleared = await saveHandler(request({ pricingProof: first.pricingProof, pricedAt: first.pricedAt }))
    expect(cleared.status).toBe(409)
    expect(await cleared.json()).toMatchObject({ error: 'saved_quote_unverifiable' })
  })
  it('reconciles a retained opaque pass with GET after repricing and without customer PII', async () => {
    const first = await reviewed()
    expect((await saveHandler(request({ pricingProof: first.pricingProof, pricedAt: first.pricedAt, customerPhone: '0411222333', customerName: 'Sam' }))).status).toBe(200)
    await reviewed(125)
    const url = new URL('https://example.test/api/tenant/commercial-painting/save-quote')
    url.search = new URLSearchParams({ paintRunId: run, extractionId: extraction, pricingProof: first.pricingProof, pricedAt: first.pricedAt }).toString()
    const result = await saveStatusHandler(new Request(url))
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ status: 'saved', paintRunId: run, extractionId: extraction,
      pricingProof: first.pricingProof, pricedAt: first.pricedAt, quoteId: expect.any(String), delivery: { attempted: false } })
    handlerIo.tenant = randomUUID()
    expect((await saveStatusHandler(new Request(url))).status).toBe(404)
  })
  it('normalizes timezone spelling while preserving microsecond pricing identity', () => {
    expect(normalisePaintPricedAt('2026-09-09T10:00:00.123456+10:00')).toBe('2026-09-09T00:00:00.123456Z')
    expect(normalisePaintPricedAt('2026-09-09T00:00:00.123457Z')).not.toBe(normalisePaintPricedAt('2026-09-09T00:00:00.123456Z'))
  })
  it('returns scoped not-found for a retained pass without creating a draft', async () => {
    const first = await reviewed()
    const url = new URL('https://example.test/api/tenant/commercial-painting/save-quote')
    url.search = new URLSearchParams({ paintRunId: run, extractionId: extraction, pricingProof: first.pricingProof, pricedAt: first.pricedAt }).toString()
    const result = await saveStatusHandler(new Request(url))
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ ok: true, status: 'not_found', paintRunId: run, extractionId: extraction,
      pricingProof: first.pricingProof, pricedAt: first.pricedAt })
    expect((await pg.query<{ n: number }>('select count(*)::int n from quotes where tenant_id=$1', [tenant])).rows[0].n).toBe(0)
  })
  it('returns only server-resolved receipt scope and never reads or writes pricing data', async () => {
    handlerIo.client = { from: vi.fn(() => { throw new Error('Unexpected pricing query') }),
      rpc: vi.fn(() => { throw new Error('Unexpected pricing RPC') }) }
    const url = new URL('https://example.test/api/tenant/commercial-painting/save-quote?scope=1&tenantId=forged&userId=forged')
    const result = await saveStatusHandler(new Request(url))
    expect(result.status).toBe(200)
    expect(result.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await result.json()).toEqual({ ok: true, tenantId: tenant, userId: `fixture-user:${tenant}` })
    const nextTenant = randomUUID()
    handlerIo.tenant = nextTenant
    expect(await (await saveStatusHandler(new Request(url))).json()).toEqual({ ok: true, tenantId: nextTenant, userId: `fixture-user:${nextTenant}` })
    expect(handlerIo.client.from).not.toHaveBeenCalled()
    expect(handlerIo.client.rpc).not.toHaveBeenCalled()
  })
  it('does not return a receipt scope to an unauthenticated request', async () => {
    handlerIo.tenant = ''
    const result = await saveStatusHandler(new Request('https://example.test/api/tenant/commercial-painting/save-quote?scope=1'))
    expect(result.status).toBe(401)
    expect(await result.json()).toEqual({ ok: false, error: 'unauthorised' })
  })
})
