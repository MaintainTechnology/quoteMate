import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlanInvitationFixture } from '../scripts/sms-plan-invitation-fixture.mjs'

const h = await vi.hoisted(async () => {
  const state = { client: null, tenant: null, attempts: [], accepted: [], unexpected: [], injected: [], enqueueFailures: 0,
    rejectCode: null, pdfs: new Map(), uploads: [], downloads: [] }
  const [http, https, net, tls, dgram, module] = await Promise.all([
    import('node:http'), import('node:https'), import('node:net'), import('node:tls'), import('node:dgram'), import('node:module'),
  ])
  const originals = []
  for (const [object, keys, label] of [
    [http.default, ['request','get'], 'HTTP'], [https.default, ['request','get'], 'HTTPS'],
    [net.default, ['connect','createConnection'], 'TCP'], [net.default.Socket.prototype, ['connect'], 'Socket'],
    [tls.default, ['connect'], 'TLS'], [dgram.default, ['createSocket'], 'UDP'], [globalThis, ['fetch'], 'fetch'],
  ]) for (const key of keys) {
    originals.push([object, key, Object.getOwnPropertyDescriptor(object, key)])
    Object.defineProperty(object, key, { configurable: true, writable: true, value: () => {
      state.unexpected.push(`${label}.${key}`); throw new Error(`Unexpected external transport: ${label}.${key}`)
    } })
  }
  module.syncBuiltinESMExports()
  return { ...state, restoreNetwork() {
    for (const [object, key, descriptor] of originals.reverse()) {
      if (descriptor) Object.defineProperty(object, key, descriptor)
      else delete object[key]
    }
    module.syncBuiltinESMExports()
  } }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (...args) => h.client.from(...args), rpc: (...args) => h.client.rpc(...args) }) }))
vi.mock('@/lib/estimation/auth', () => ({ tenantFromBearer: async request =>
  request.headers.get('authorization') === 'Bearer offline-invitation-owner' ? h.tenant : null }))
vi.mock('@/lib/sms/twilio', () => ({ sendSms: async options => {
  // A real stored owned request must exist before even the fixture carrier sees its link.
  const urls = options.text.match(/https?:\/\/[^\s]+/g) ?? []
  expect(urls).toHaveLength(1)
  const url = new URL(urls[0])
  expect(url.origin).toBe('https://quotemax.com.au')
  expect(url.pathname).toMatch(/^\/upload\/plan\/[a-f0-9]{32}$/)
  const stored = await h.client.from('plan_upload_requests').select('*').eq('token', url.pathname.split('/').at(-1)).single()
  expect(stored.error).toBeNull()
  expect(stored.data).toMatchObject({ tenant_id: h.tenant.id, customer_phone: options.to, twilio_number: options.from, status: 'awaiting_upload' })
  h.attempts.push({ ...options, requestId: stored.data.id, token: stored.data.token, rejected: h.rejectCode })
  if (h.rejectCode) return { ok: false, code: h.rejectCode, reason: 'Explicit fixture provider rejection', raw: null }
  const sid = `SM${String(h.accepted.length + 1).padStart(32, '0')}`
  h.accepted.push({ ...options, sid }); return { ok: true, sid, status: 'queued' }
}, sendWhatsApp: async () => { h.unexpected.push('WhatsApp'); throw new Error('Unexpected WhatsApp') },
readTwilioMessage: async () => { h.unexpected.push('carrier-reconciliation'); throw new Error('Unexpected reconciliation') } }))

import { maybeHandlePlanEstimation } from '@/lib/sms/plan-estimation'
import { recoverSmsOutbox } from '@/lib/sms/dispatch'
import { enqueueSmsWork, runSmsWorkBatch, assertSmsWorkOwnership } from '@/lib/sms/durable-work'
import { withSmsDeliveryContext } from '@/lib/sms/delivery-context'
import { GET as deliveryQueue, POST as ownerRetry } from '@/app/api/tenant/sms-delivery/route'

const app = fileURLToPath(new URL('../', import.meta.url)), WEBSITE = 'https://quotemax.com.au'
const TENANT = '11111111-1111-4111-8111-111111111111', SENDER = '+61488888888'
const output = join(app, '../docs/audits/2026-09-09-sms-plan-invitation-recovery.json')
const tracked = ['tests/sms-plan-invitation-recovery.test.mjs','scripts/sms-plan-invitation-fixture.mjs',
  'scripts/vitest-sms-plan-created-release.config.mjs','scripts/sms-plan-created-release-fixture.mjs',
  'scripts/sms-owner-release-fixture.mjs','scripts/sms-route-fixture-db.mjs',
  'lib/sms/plan-estimation.ts','lib/estimation/plan-request.ts','lib/sms/dispatch.ts','lib/sms/durable-work.ts',
  'lib/sms/durable-outbox.ts','lib/sms/delivery-context.ts','lib/sms/public-origin.ts','app/api/tenant/sms-delivery/route.ts',
  ...['198_sms_durable_work.sql','199_sms_delivery_outbox.sql','201_sms_trade_quote_contract.sql','202_job_quote_operations.sql',
    '205_generic_quote_customer_release.sql','207_quote_pricing_versions.sql','210_sms_plan_work.sql',
    '211_commercial_quote_release_guard.sql','212_plan_quote_release_guard.sql','215_generic_release_snapshot.sql',
    '217_final_quote_credit_settlement.sql'].map(name => `sql/migrations/${name}`)]
const hash = path => createHash('sha256').update(readFileSync(join(app, path))).digest('hex')
const evidence = { completed: false, results: [], failedTests: [], sourceHashes: Object.fromEntries(tracked.map(path => [path, hash(path)])),
  limits: ['Actual plan invitation helper, SQL199 request/outbox, SQL198 claim/retry, dispatcher/recovery and owner delivery GET/POST execute over one local PGlite connection.',
    'A fixture inbound adapter invokes the real helper under actual durable work and delivery ownership contexts; actual webhook signature parsing, routing and compiled bootstrap are not executed.',
    'Only tenant identity is seeded. The actual request RPC creates the upload invitation, token, conversation and inbound message.',
    'Carrier rejections/acceptance and one pre-enqueue database error are explicit fixtures. All network transports are denied and recorded.',
    'Recovery due timestamps are advanced in local SQL; no real scheduler wait, process kill, production RLS/PostgREST or carrier delivery is claimed.',
    'Upload, extraction, owner quote review/public access are retained in the separate same-config plan journey. Named hashes do not cover every transitive import.'] }
let db
const rows = async table => { const result = await db.client.from(table).select('*'); expect(result.error).toBeNull(); return result.data }
const ownerRequest = (body, authorised = true) => new Request(`${WEBSITE}/api/tenant/sms-delivery`, {
  method: body ? 'POST' : 'GET', headers: { ...(authorised ? { authorization: 'Bearer offline-invitation-owner' } : {}), 'content-type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
})
const handler = async request => {
  const input = await request.json()
  expect(await maybeHandlePlanEstimation({ ...input, tenant: h.tenant, supabase: db.client })).toBe(true)
  return Response.json({ handled: true })
}
const run = () => runSmsWorkBatch({ inbound: handler }, { db: db.client, limit: 1,
  scope: (job, operation) => withSmsDeliveryContext({ tenantId: TENANT, turnId: job.turn_id,
    workId: job.id, workOwner: job.owner_token, assertOwnership: assertSmsWorkOwnership }, operation) })

beforeAll(async () => {
  writeFileSync(output, JSON.stringify(evidence, null, 2))
  vi.stubEnv('PUBLIC_WEB_ORIGIN', WEBSITE); vi.stubEnv('APP_URL', 'https://offline-engine.invalid')
  vi.stubEnv('ENGINE_BASE_URL', 'https://offline-engine.invalid'); vi.stubEnv('SMS_WORKER_SERVICE', 'platform')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://offline-db.invalid'); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'offline-invitation-key')
  vi.stubEnv('TWILIO_SMS_NUMBER', '+61400000000'); vi.stubEnv('TWILIO_PHONE_NUMBER', '+61400000000')
  db = await createPlanInvitationFixture(app, h); h.client = db.client
  h.tenant = { id: TENANT, business_name: 'Offline plan electrician', trade: 'electrical', twilio_sms_number: SENDER, sms_estimator_enabled: true }
  await db.seed('tenants', [{ id: TENANT, business_name: h.tenant.business_name, trade: 'electrical', twilio_sms_number: SENDER }])
}, 20000)
afterAll(async () => {
  try {
    for (const [path, expected] of Object.entries(evidence.sourceHashes)) expect(hash(path)).toBe(expected)
    expect(h.unexpected).toEqual([])
    expect(h.accepted).toHaveLength(4)
    expect(await rows('plan_upload_requests')).toHaveLength(4)
    expect(await rows('sms_conversations')).toHaveLength(4)
    expect(await rows('sms_work_jobs')).toHaveLength(4)
    expect(await rows('sms_outbox')).toHaveLength(4)
    evidence.completed = evidence.results.length === 4 && evidence.failedTests.length === 0
  } finally {
    if (db) await db.close()
    Object.assign(evidence, { generatedAt: new Date().toISOString(), carrierAttempts: h.attempts,
      acceptedCarrierCalls: h.accepted.length, injectedFailures: h.injected, unexpected: h.unexpected })
    writeFileSync(output, JSON.stringify(evidence, null, 2)); vi.unstubAllEnvs(); h.restoreNetwork()
  }
})

it.each(['accepted','transient','permanent','enqueue'])('plan upload invitation: %s dispatch preserves one request and intended send', async mode => {
  try {
    const index = ['accepted','transient','permanent','enqueue'].indexOf(mode)
    const phone = `+6141111119${index}`, sid = `SM${String(index + 100).padStart(32, '0')}`
    const input = { fromNumber: phone, toNumber: SENDER, inboundBody: 'Can you quote my electrical plan?', messageSid: sid, customerFirstName: 'Sam' }
    const receipt = () => enqueueSmsWork({ key: `inbound:${sid}`, kind: 'inbound', serialKey: `${TENANT}:${phone}`, tenantId: TENANT,
      payload: { url: `${WEBSITE}/offline-plan-invitation-adapter`, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } }, db.client)
    const job = await receipt()
    expect((await receipt()).id).toBe(job.id)
    const before = h.attempts.length
    h.rejectCode = mode === 'transient' ? '429' : mode === 'permanent' ? '21612' : null
    h.enqueueFailures = mode === 'enqueue' ? 1 : 0
    expect(await run()).toEqual([{ id: job.id, ok: mode !== 'enqueue' }])
    const ownedRequests = () => rows('plan_upload_requests').then(values => values.filter(row => row.customer_phone === phone))
    const requests = await ownedRequests()
    expect(requests).toHaveLength(1)
    const saved = requests[0]
    expect(saved).toMatchObject({ tenant_id: TENANT, customer_phone: phone, twilio_number: SENDER, status: 'awaiting_upload' })
    expect(saved.token).toMatch(/^[a-f0-9]{32}$/)
    const conversation = (await rows('sms_conversations')).find(row => row.id === saved.sms_conversation_id)
    expect(conversation).toMatchObject({ tenant_id: TENANT, from_number: phone, to_number: SENDER, conversation_type: 'plan_estimation' })
    const ownedIntents = () => rows('sms_outbox').then(values => values.filter(row => row.to_number === phone))
    let failedState = null, queueEvidence = null
    if (mode === 'enqueue') {
      expect(h.attempts).toHaveLength(before); expect(await ownedIntents()).toEqual([])
      failedState = (await rows('sms_work_jobs')).find(row => row.id === job.id)
      expect(failedState).toMatchObject({ tenant_id: TENANT, status: 'retry', attempts: 1 })
      expect(failedState.last_error).toContain('Plan upload notification could not be queued')
      expect((await receipt()).id).toBe(job.id)
      await db.pg.query('update sms_work_jobs set available_at=now() where id=$1', [job.id])
      expect(await run()).toEqual([{ id: job.id, ok: true }])
    } else if (mode !== 'accepted') {
      const failed = (await ownedIntents())[0]
      expect(failed).toMatchObject({ status: mode === 'transient' ? 'retry' : 'failed', requires_attention: mode === 'permanent', provider_sid: null })
      expect(failed.result).toMatchObject({ ok: false, smsAttempt: { code: h.rejectCode } })
      expect((await rows('sms_messages')).filter(row => row.outbox_id === failed.id)).toEqual([])
      const visible = await deliveryQueue(ownerRequest())
      expect(visible.status).toBe(200)
      queueEvidence = (await visible.json()).messages.find(row => row.id === failed.id)
      expect(queueEvidence).toMatchObject({ id: failed.id, status: failed.status, to_number: phone, requires_attention: mode === 'permanent' })
      failedState = { outboxId: failed.id, status: failed.status, attempts: failed.attempts, code: failed.result.smsAttempt.code }
      const duplicate = () => withSmsDeliveryContext({ tenantId: TENANT, turnId: job.turn_id }, () =>
        maybeHandlePlanEstimation({ ...input, tenant: h.tenant, supabase: db.client }))
      const attemptsBeforeReplay = h.attempts.length
      expect(await duplicate()).toBe(true)
      expect(h.attempts).toHaveLength(attemptsBeforeReplay)
      expect(await ownedRequests()).toEqual(requests); expect(await ownedIntents()).toHaveLength(1)
      h.rejectCode = null
      if (mode === 'permanent') {
        expect((await ownerRetry(ownerRequest({ id: failed.id }, false))).status).toBe(401)
        const retry = await ownerRetry(ownerRequest({ id: failed.id }))
        expect(retry.status).toBe(200); expect(await retry.json()).toEqual({ ok: true, status: 'retry' })
      } else await db.pg.query('update sms_outbox set next_attempt_at=now() where id=$1', [failed.id])
      expect(await recoverSmsOutbox(10)).toEqual({ attempted: 1, reconciled: 0 })
    }
    const intents = await ownedIntents()
    expect(intents).toHaveLength(1)
    const intent = intents[0]
    expect(intent).toMatchObject({ tenant_id: TENANT, conversation_id: saved.sms_conversation_id, status: 'accepted', requires_attention: false,
      delivery_key: `plan-upload:${sid}`, payload: { tenantId: TENANT, from: SENDER, to: phone } })
    const accepted = h.accepted.filter(call => call.sid === intent.provider_sid)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({ from: SENDER, to: phone, text: intent.payload.text })
    expect(intent.body).toContain(`${WEBSITE}/upload/plan/${saved.token}`)
    const transcript = (await rows('sms_messages')).filter(row => row.outbox_id === intent.id)
    expect(transcript).toHaveLength(1)
    expect(transcript[0]).toMatchObject({ conversation_id: saved.sms_conversation_id, tenant_id: TENANT, to_number: phone,
      body: intent.body, twilio_message_sid: intent.provider_sid, delivery_status: 'accepted' })
    expect(await withSmsDeliveryContext({ tenantId: TENANT, turnId: job.turn_id }, () =>
      maybeHandlePlanEstimation({ ...input, tenant: h.tenant, supabase: db.client }))).toBe(true)
    expect((await receipt()).id).toBe(job.id); expect(await run()).toEqual([])
    expect(await recoverSmsOutbox(10)).toEqual({ attempted: 0, reconciled: 0 })
    expect(await ownedRequests()).toEqual(requests)
    expect(await ownedIntents()).toEqual(intents)
    expect((await rows('sms_messages')).filter(row => row.twilio_message_sid === sid)).toHaveLength(1)
    expect((await rows('sms_messages')).filter(row => row.outbox_id === intent.id)).toEqual(transcript)
    expect(h.attempts.length - before).toBe(mode === 'transient' ? 5 : mode === 'permanent' ? 2 : 1)
    evidence.results.push({ mode, passed: true, jobId: job.id, requestId: saved.id, conversationId: saved.sms_conversation_id,
      token: saved.token, outboxId: intent.id, transcriptId: transcript[0].id, carrierAttempts: h.attempts.length - before,
      acceptedSid: intent.provider_sid, failureBeforeRecovery: failedState, ownerQueueBeforeRecovery: queueEvidence })
  } catch (error) { evidence.failedTests.push({ mode, error: String(error) }); throw error }
}, 20000)
