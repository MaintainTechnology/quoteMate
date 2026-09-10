import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import providers from '../scripts/sms-route-provider-fixtures.cjs'
import { ADDRESS, BOOK, CONVERSATION, CUSTOMER, FORM_TOKEN, OWNER, TENANT, TO,
  briefFor, createResidentialFixture, sourceHashes, strictModel } from '../scripts/sms-residential-form-parity-fixture.mjs'

const h = vi.hoisted(() => ({ client: null, model: null, spec: null, events: [], carrier: [], checkout: [], after: [],
  unexpected: [], observe: null, stripe: null }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  from: (...args) => h.client.from(...args), rpc: (...args) => h.client.rpc(...args), storage: { from: (...args) => h.client.storage.from(...args) },
}) }))
vi.mock('ai', async original => ({ ...await original(),
  generateObject: options => h.model.generateObject(options), generateText: options => h.model.generateText(options),
  embed: async () => { h.events.push({ kind: 'embedding' }); return { embedding: Array(1536).fill(0.01), usage: { tokens: 1 } } },
}))
vi.mock('next/server', () => ({ after: callback => { h.after.push(callback) } }))
vi.mock('@/lib/sms/twilio', () => ({ sendSms: async options => {
  const sid = `SM${String(h.carrier.length + 1).padStart(32, '0')}`
  h.carrier.push({ ...options, sid }); return { ok: true, sid, status: 'queued' }
}, sendWhatsApp: async () => { h.unexpected.push('Unexpected WhatsApp'); throw new Error('Unexpected WhatsApp') },
readTwilioMessage: async () => { h.unexpected.push('Unexpected reconciliation'); throw new Error('Unexpected reconciliation') } }))
vi.mock('@/lib/stripe/client', () => ({ getStripe: () => h.stripe }))
// Observers assert their inputs, then execute the unchanged real business code.
vi.mock('@/lib/intake/structure', async original => { const actual = await original(); return { ...actual,
  structureIntake: (...args) => { h.observe('structureIntake', args); return actual.structureIntake(...args) } } })
vi.mock('@/lib/estimate/run', async original => { const actual = await original(); return { ...actual,
  runEstimation: (...args) => { h.observe('runEstimation', args); return actual.runEstimation(...args) } } })
vi.mock('@/lib/roofing/measure', async original => { const actual = await original(); return { ...actual,
  measureAndPriceRoofs: (...args) => { h.observe('measureAndPriceRoofs', args); return actual.measureAndPriceRoofs(...args) } } })
vi.mock('@/lib/roofing/pricing', async original => { const actual = await original(); return { ...actual,
  priceMultiRoof: (...args) => { h.observe('priceMultiRoof', args); return actual.priceMultiRoof(...args) } } })

const app = fileURLToPath(new URL('../', import.meta.url)), WEB = 'https://quotemax.com.au'
const output = join(app, '../docs/audits/2026-09-09-sms-residential-form-parity-results.json')
const entries = ['tests/sms-residential-form-parity.test.mjs','scripts/vitest-sms-residential-form-parity.config.mjs',
  'app/api/quote-request/[token]/route.ts','app/api/intake/structure/route.ts','app/api/estimate/draft/route.ts',
  'lib/sms/roofing-measure-dispatch.ts','lib/sms/quote-actions.ts','pnpm-lock.yaml',
  ...['122_sms_conversation_active_unique.sql','154_painting_sms_receptionist.sql','190_trade_lead_requests.sql','191_push_tokens.sql',
    '198_sms_durable_work.sql','199_sms_delivery_outbox.sql','201_sms_trade_quote_contract.sql','207_quote_pricing_versions.sql'].map(name => `sql/migrations/${name}`)]
const report = { completed: false, results: [], failedTests: [], unexpected: [], sourceHashes: {}, limits: [
  'Actual residential form POST compared with canonical SMS finish business boundaries: electrical/plumbing intake POST and durable estimation; roofing shared dispatcher. Full inbound conversation parsing is separately tested by compiled journeys.',
  'Identical tenant, complete active rate card and explicitly validated brief in separate local PGlite databases. No intake, priced quote or review task is seeded.',
  'Only model, embedding, carrier, optional location and Stripe provider boundaries are fixtures. Model responses require the actual brief and correct trade hint before executing the real money tool.',
  'Roof measurement uses the existing deterministic mock measurement provider; its real measurement orchestration, tenant pricing and persistence remain active. This does not prove live Geoscape accuracy.',
  'Minimal local schema and PostgREST-shaped adapter are not production RLS, remote schema, carrier delivery, browser form interaction or deployed certification.',
] }
let routes, active, priorFetch
const unexpected = message => { h.unexpected.push(message); return new Error(message) }
const request = (path, body) => new Request(`${WEB}${path}`, { method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: 'Bearer offline-parity-cron' }, body: JSON.stringify(body) })

beforeAll(async () => {
  for (const [key, value] of Object.entries({ NEXT_PUBLIC_SUPABASE_URL: 'https://offline-db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'offline-only',
    APP_URL: WEB, PUBLIC_WEB_ORIGIN: WEB, CRON_SECRET: 'offline-parity-cron', SMS_WORKER_SERVICE: 'residential-parity',
    ANTHROPIC_API_KEY: 'offline-only', ROOFING_PROVIDER: 'mock', ROOFING_SOLAR_ENRICHMENT: 'false', PROPRADAR_ENRICHMENT: 'false',
    GOOGLE_GEOCODE_API_KEY: 'offline-only', GOOGLE_MAPS_API_KEY: '', GOOGLE_SOLAR_API_KEY: '', GEOSCAPE_API_KEY: '',
    RAG_DISABLED: 'true', TENANT_FILESTORE_ENABLED: 'false', IG_ENGINE_ENABLED: '0', SMS_QUOTE_PDF_MMS: '0', WP9_PRODUCT_OPTIONS: '0',
    TWILIO_AUTH_TOKEN: 'offline-only', TWILIO_ACCOUNT_SID: 'AC11111111111111111111111111111111',
  })) vi.stubEnv(key, value)
  priorFetch = global.fetch
  global.fetch = async (input, options) => {
    const req = new Request(input, options), url = new URL(req.url)
    if (url.origin === WEB && url.pathname === '/api/intake/structure') {
      try {
        assert.equal(req.method, 'POST'); assert.equal(req.headers.get('authorization'), 'Bearer offline-parity-cron')
        assert.deepEqual(await req.clone().json(), { conversationId: CONVERSATION, sourceChannel: 'sms' })
        h.events.push({ kind: 'internal-http', path: url.pathname })
        return await routes.intake(req)
      } catch (error) { throw unexpected(`Internal handoff fixture: ${error.message}`) }
    }
    try { const response = await providers.providerResponse(url, req); if (response) { h.events.push({ kind: 'location-provider', path: url.pathname }); return response } }
    catch (error) { throw unexpected(`Location fixture: ${error.message}`) }
    throw unexpected(`Unexpected fetch ${url.origin}${url.pathname}`)
  }
  for (const transport of [http, https]) for (const name of ['request','get']) vi.spyOn(transport, name).mockImplementation(() => { throw unexpected(`Unexpected Node HTTP ${name}`) })
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => { throw unexpected('Unexpected TCP connection') })
  vi.spyOn(tls, 'connect').mockImplementation(() => { throw unexpected('Unexpected TLS connection') })
  h.observe = (name, args) => {
    try {
      if (name === 'structureIntake') { assert.ok(args[0].includes(h.spec.brief)); assert.equal(args[2], h.spec.config.trade) }
      if (name === 'runEstimation') {
        assert.equal(args[0].job_type, h.spec.config.jobType); assert.equal(args[0].address, ADDRESS)
        assert.equal(args[0].scope.description, h.spec.brief); assert.equal(args[0].scope.item_count, h.spec.config.structure.scope.item_count)
        assert.equal(args[1].id, BOOK); assert.equal(args[1].tenant_id, TENANT); assert.equal(Number(args[1].hourly_rate), 120)
      }
      if (name === 'measureAndPriceRoofs') {
        assert.deepEqual(args[0], h.spec.form.address)
        assert.equal(args[1].material, h.spec.form.inputs.material); assert.equal(args[1].pitch, h.spec.form.inputs.pitch)
        assert.equal(args[1].building_year_built, h.spec.form.inputs.building_year_built)
        assert.deepEqual(args[2].rateCard, h.spec.config.seed.pricing_book[0].overlays.roofing_rate_card)
      }
      if (name === 'priceMultiRoof') assert.deepEqual(args[0].rateCard, h.spec.config.seed.pricing_book[0].overlays.roofing_rate_card)
      h.events.push({ kind: 'actual-function', name })
    } catch (error) { throw unexpected(`Real ${name} input: ${error.message}`) }
  }
  const [form, intake, estimate, roof, work, scope, dispatch, actions] = await Promise.all([
    import('@/app/api/quote-request/[token]/route'), import('@/app/api/intake/structure/route'), import('@/app/api/estimate/draft/route'),
    import('@/lib/sms/roofing-measure-dispatch'), import('@/lib/sms/durable-work'), import('@/lib/sms/work-delivery-context'),
    import('@/lib/sms/dispatch'), import('@/lib/sms/quote-actions'),
  ])
  routes = { form: form.POST, intake: intake.POST, estimate: estimate.POST, roof: roof.measureAndDispatchRoofing,
    batch: work.runSmsWorkBatch, scope: scope.smsDeliveryWorkScope, dispatch: dispatch.dispatchQuoteMessage, actions }
  report.sourceHashes = sourceHashes(app, entries)
}, 30_000)

async function drain() {
  for (let pass = 0; pass < 12; pass++) {
    while (h.after.length) await h.after.shift()()
    const batch = await routes.batch({ intake: routes.intake, estimate: routes.estimate }, { db: h.client, scope: routes.scope, limit: 8 })
    assert.ok(batch.every(row => row.ok), `Real durable worker failed: ${JSON.stringify(batch)}`)
    if (!batch.length && !h.after.length) return
  }
  throw unexpected('Work failed to quiesce within 12 bounded drains')
}

async function snapshot() {
  const result = {}
  for (const table of ['intakes','quotes','roofing_measurements','sms_human_tasks','sms_outbox','sms_messages','sms_conversations','trade_lead_requests','sms_work_jobs','quote_pricing_versions']) {
    result[table] = (await active.pg.query(`select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`)).rows.map(item => item.row)
  }
  return result
}

async function runLane(trade, lane) {
  const spec = briefFor(trade); h.spec = spec; h.events = []; h.carrier = []; h.checkout = []; h.after = []
  h.model = strictModel(spec, lane, async event => { h.events.push(event) }, unexpected)
  active = await createResidentialFixture(app, spec, lane, unexpected); h.client = active.client
  h.stripe = { checkout: { sessions: { create: async params => {
    try {
      const rows = (await active.pg.query('select * from quotes')).rows
      assert.equal(rows.length, 1, 'Checkout happens after an actual saved quote')
      assert.equal(params.metadata.quote_id, rows[0].id); assert.equal(params.metadata.tier, 'inspection')
      assert.equal(params.line_items.length, 1); assert.equal(params.line_items[0].price_data.currency, 'aud')
      assert.equal(params.line_items[0].price_data.unit_amount, 9900)
      assert.equal(new URL(params.success_url).origin, WEB); assert.ok(params.success_url.includes(rows[0].share_token))
      h.checkout.push(params); return { id: 'cs_test_parity', url: 'https://checkout.stripe.com/c/pay/cs_test_parity' }
    } catch (error) { throw unexpected(`Stripe fixture: ${error.message}`) }
  } } } }
  try {
    let response, originalResult, roofArgs
    if (lane === 'form') {
      response = await routes.form(request(`/api/quote-request/${FORM_TOKEN}`, spec.form), { params: Promise.resolve({ token: FORM_TOKEN }) })
      originalResult = await response.json(); assert.equal(response.status, 200, JSON.stringify(originalResult)); assert.equal(originalResult.ok, true)
      assert.equal(originalResult.texted, trade === 'roofing' ? false : null)
    } else if (trade === 'roofing') {
      roofArgs = { supabase: h.client, tenantId: TENANT, tenantTrade: trade, conversationId: CONVERSATION,
        requestKey: 'sms-parity:roof', customerPhone: CUSTOMER, replyFrom: TO, firstName: 'Sam', baseUrl: WEB,
        slots: { ...spec.form.address, address_confirmed: true, addr_verified: ADDRESS, material: spec.form.inputs.material,
          pitch: spec.form.inputs.pitch, intent: spec.form.inputs.intent, year_built: spec.form.inputs.building_year_built }, isInspection: false,
        sendReply: text => routes.dispatch({ to: CUSTOMER, from: TO, text, tenantId: TENANT, conversationId: CONVERSATION,
          audience: 'customer', deliveryKey: 'sms-parity:roof:status' }) }
      originalResult = await routes.roof(roofArgs); assert.equal(originalResult.ok, true, JSON.stringify(originalResult))
      await h.client.from('sms_conversations').update({ roofing_state: originalResult.state }).eq('id', CONVERSATION)
    } else {
      response = await routes.intake(request('/api/intake/structure', { conversationId: CONVERSATION, sourceChannel: 'sms' }))
      originalResult = await response.json(); assert.equal(response.status, 200, JSON.stringify(originalResult))
    }
    await drain()
    const before = await snapshot(), functionCounts = h.events.filter(e => e.kind === 'actual-function'), sends = h.carrier.length
    const record = trade === 'roofing' ? before.roofing_measurements[0] : before.quotes[0]
    assert.equal((trade === 'roofing' ? before.roofing_measurements : before.quotes).length, 1)
    assert.equal(record.tenant_id, TENANT); assert.ok(record.public_token ?? record.share_token)
    assert.equal(record.released_at ?? record.customer_released_at ?? null, null)
    assert.equal(before.sms_human_tasks.length, 1)
    const task = before.sms_human_tasks[0]
    assert.equal(task.tenant_id, TENANT); assert.equal(task.customer_phone, CUSTOMER); assert.equal(task.conversation_id, CONVERSATION)
    assert.equal(task.resource_id, record.id); assert.equal(task.resource_type, trade === 'roofing' ? 'roof' : 'generic'); assert.equal(task.status, 'notified')
    assert.equal(task.notification_error, null)
    assert.equal(h.carrier.length, 2, 'Only the saved-draft customer status and owner review notice may be sent')
    assert.equal(h.carrier.filter(item => item.to === OWNER).length, 1, 'Exactly one actual owner review notification must be accepted')
    const customer = h.carrier.filter(item => item.to === CUSTOMER)
    assert.equal(customer.length, 1); assert.match(customer[0].body ?? customer[0].text, /saved.*review|review.*saved/is)
    for (const item of customer) assert.doesNotMatch(item.body ?? item.text, /https?:\/\/|\$\s*\d|sending.*link|quote.*on.*way/i)
    assert.ok(before.sms_outbox.every(row => row.status === 'accepted'))
    assert.equal(before.sms_outbox.length, h.carrier.length)
    for (const outbox of before.sms_outbox) {
      const sent = h.carrier.filter(item => item.sid === outbox.provider_sid)
      assert.equal(sent.length, 1); assert.equal(outbox.tenant_id, TENANT)
      assert.equal(outbox.payload.to, sent[0].to); assert.equal(outbox.payload.from, TO)
      assert.equal(outbox.payload.text, sent[0].text); assert.equal(sent[0].from, TO)
      assert.equal(outbox.audience, sent[0].to === CUSTOMER ? 'customer' : 'tradie')
    }
    assert.equal(before.sms_messages.filter(row => row.direction === 'outbound').length, 2)
    assert.equal(before.sms_messages.filter(row => row.direction === 'outbound' && row.audience === 'customer').length, customer.length)
    const transcript = before.sms_messages.find(row => row.direction === 'outbound' && row.audience === 'customer')
    assert.equal(transcript.conversation_id, CONVERSATION); assert.equal(transcript.tenant_id, TENANT)
    assert.equal(transcript.to_number, CUSTOMER); assert.equal(transcript.body, customer[0].text)
    assert.equal(transcript.twilio_message_sid, customer[0].sid); assert.equal(transcript.delivery_status, 'accepted')
    assert.equal(transcript.outbox_id, before.sms_outbox.find(row => row.audience === 'customer').id)
    assert.ok(before.sms_work_jobs.every(row => row.status === 'completed'))
    if (trade === 'roofing') {
      assert.equal(before.sms_conversations[0].roofing_state.workflow_stage, 'awaiting_review')
      assert.ok(Number(record.combined_better_inc_gst) > 0); assert.equal(record.provider, 'mock')
      assert.ok(functionCounts.some(row => row.name === 'priceMultiRoof'))
    } else {
      assert.equal(before.intakes.length, 1); assert.equal(before.intakes[0].trade, trade)
      assert.equal(record.status, 'awaiting_tradie_approval'); assert.equal(before.sms_conversations[0].quote_stage, 'awaiting_review')
      assert.ok(Number(record.total_inc_gst) > 0); assert.equal(before.quote_pricing_versions.length, 1)
      assert.equal(record.pricing_book_version_id, before.quote_pricing_versions[0].id)
      assert.deepEqual(functionCounts.map(row => row.name), ['structureIntake','runEstimation'])
      assert.equal(h.checkout.length, 1)
    }
    // Replay the original real form or SMS business request, not a seeded saved
    // result. Form one-shot 409 is part of the public contract.
    let replayResult, replayStatus
    if (lane === 'form') {
      const replay = await routes.form(request(`/api/quote-request/${FORM_TOKEN}`, spec.form), { params: Promise.resolve({ token: FORM_TOKEN }) })
      replayStatus = replay.status; replayResult = await replay.json()
      assert.equal(replayStatus, 409); assert.equal(replayResult.error, 'already_submitted')
    } else if (trade === 'roofing') { replayResult = await routes.roof(roofArgs); assert.equal(replayResult.ok, true); assert.equal(replayResult.token, record.public_token) }
    else { const replay = await routes.intake(request('/api/intake/structure', { conversationId: CONVERSATION, sourceChannel: 'sms' })); replayStatus = replay.status; replayResult = await replay.json(); assert.equal(replayStatus, 200) }
    await drain()
    const after = await snapshot()
    assert.deepEqual(after, before, 'Replaying the same input must not mutate saved price/token/task/history/work identity')
    assert.equal(h.carrier.length, sends); assert.deepEqual(h.events.filter(e => e.kind === 'actual-function'), functionCounts)
    if (lane === 'form') { assert.equal(before.trade_lead_requests[0].status, 'submitted'); assert.ok(before.trade_lead_requests[0].submitted_at) }
    assert.equal(h.unexpected.length, 0, JSON.stringify(h.unexpected))
    return { lane, originalResult, replayStatus, replayResult, saved: before, events: h.events, carrier: h.carrier, checkout: h.checkout }
  } finally { await active.close(); active = null; h.client = null }
}

for (const trade of ['electrical','plumbing','roofing']) it(`${trade}: actual residential form and SMS finish produce the same owned held draft`, async () => {
  try {
    const form = await runLane(trade, 'form'), sms = await runLane(trade, 'sms')
    const project = lane => {
      if (trade === 'roofing') {
        const saved = lane.saved.roofing_measurements[0]
        return { address: saved.address, postcode: saved.postcode, state: saved.state, provider: saved.provider,
          structures: saved.structures, quote: saved.quote, total: saved.combined_better_inc_gst, stage: lane.saved.sms_conversations[0].roofing_state.workflow_stage }
      }
      const intake = lane.saved.intakes[0], quote = lane.saved.quotes[0]
      return { intake: Object.fromEntries(['trade','job_type','address','suburb','caller','scope','access','property','risks','confidence','inspection_required'].map(key => [key, intake[key]])),
        quote: Object.fromEntries(['good','better','best','total_inc_gst','gst_registered','status','scope_short','inspection_required'].map(key => [key, quote[key]])),
        pricing: lane.saved.quote_pricing_versions[0].snapshot, pricingHash: lane.saved.quote_pricing_versions[0].content_hash,
        stage: lane.saved.sms_conversations[0].quote_stage }
    }
    expect(project(form)).toEqual(project(sms))
    report.results.push({ trade, passed: true, comparison: project(form), form, sms })
  } catch (error) { report.failedTests.push({ trade, message: error.message }); throw error }
}, 90_000)

afterAll(async () => {
  if (active) { await active.close(); active = null }
  report.unexpected = [...h.unexpected]
  try { assert.deepEqual(sourceHashes(app, entries), report.sourceHashes, 'Exercised source changed during parity run') }
  catch (error) { report.failedTests.push({ sourceBinding: error.message }) }
  report.completed = report.results.length === 3 && !report.failedTests.length && !report.unexpected.length
  report.finishedAt = new Date().toISOString()
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  if (priorFetch) global.fetch = priorFetch
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  // A caught adapter/network failure must fail the suite as well as the report.
  expect(report.unexpected).toEqual([]); expect(report.failedTests).toEqual([])
})
