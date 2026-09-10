// Offline acceptance child. Production compiled worker/outbox code is loaded
// unchanged; the three stage handlers below are deliberately labelled fixtures.
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS child loads the CommonJS candidate build. */
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const [candidate, endpoint, mode, boundary, scenario, tenant, conversation, trade, followupSerial] = process.argv.slice(2)
const load = createRequire(resolve(candidate, 'package.json'))
const work = load(resolve(candidate, 'dist/lib/sms/durable-work.js'))
const outbox = load(resolve(candidate, 'dist/lib/sms/durable-outbox.js'))
const context = load(resolve(candidate, 'dist/lib/sms/delivery-context.js'))
process.env.SMS_WORKER_SERVICE = trade
process.env.PUBLIC_WEB_ORIGIN = 'https://quotemax.com.au'
const nativeFetch = global.fetch
global.fetch = (input, options) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input)
  if (!url.startsWith(`${endpoint}/`)) throw new Error(`Offline worker blocked network: ${new URL(url).origin}`)
  return nativeFetch(input, options)
}
async function remote(path, body) {
  const response = await fetch(`${endpoint}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(await response.text())
  return response.json()
}
const db = {
  rpc: (name, args) => remote('rpc', { name, args }),
  from(table) {
    let action = 'select', payload, single = false
    const filters = {}
    const builder = {
      select: () => builder,
      eq: (name, value) => { filters[name] = value; return builder },
      insert: (value) => { action = 'insert'; payload = value; return builder },
      update: (value) => { action = 'update'; payload = value; return builder },
      single: () => { single = true; return builder },
      maybeSingle: () => { single = true; return builder },
      then: (resolve, reject) => remote('table', { table, action, payload, filters, single }).then(resolve, reject),
    }
    return builder
  },
}
const fenced = work.withFencedSmsClient(db)
async function checked(query) {
  const result = await query
  if (result.error) throw new Error(JSON.stringify(result.error))
  return result.data
}
async function gate(name) {
  if (boundary !== name) return
  process.send?.({ event: 'boundary', name, pid: process.pid, owner: work.currentSmsWork()?.ownerToken, job: work.currentSmsWork()?.jobId })
  // Kill tests terminate this exact child. Burst tests resume it over IPC after
  // a competitor proves the predecessor still owns the serial queue.
  await new Promise(resolve => {
    const timer = setInterval(() => {}, 1000)
    process.once('message', message => { if(message.command === 'continue') { clearInterval(timer);resolve() } })
  })
}
const payload = (body) => ({ url: `${endpoint}/fixture`, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function enqueue(kind, key, body, serial = conversation) {
  return work.enqueueSmsWork({ key: `${scenario}:${key}`, kind, serialKey: `${scenario}:${serial}`, tenantId: tenant, payload: payload(body) }, db)
}
async function savedRow(table, key, value, row) {
  const existing = await checked(db.from(table).select().eq(key, value).maybeSingle())
  if (existing) return existing
  const result = await fenced.from(table).insert(row).select().single()
  if (result.error?.code === '23505') return checked(db.from(table).select().eq(key, value).single())
  if (result.error) throw new Error(JSON.stringify(result.error))
  return result.data
}
async function deliver(key, text) {
  const row = await outbox.enqueueOutbound({ deliveryKey: `${scenario}:${key}`, tenantId: tenant, conversationId: conversation,
    to: '+61400000001', from: '+61400000002', text }, db)
  if (key === 'initial-status') await gate('outbox')
  return outbox.processOutbound(row, async () => {
    const result = await remote('carrier', { scenario, key, outbox: row.id })
    if (key === 'initial-status') await gate('ambiguous')
    return { ok: true, channel: 'sms', sid: result.sid, status: 'queued' }
  }, db)
}
const handlers = {
  async inbound(request) {
    const input = await request.json()
    if(input.action === 'initial') await gate('before-history')
    await work.smsWorkCheckpoint('history', async () => checked(db.from('sms_messages').select().eq('conversation_id',conversation)))
    if(input.action === 'initial') await gate('after-history')
    await work.smsWorkCheckpoint('decision', async () => { await remote('event', { scenario, kind: 'model', key: input.action }); return input })
    await savedRow('sms_messages', 'twilio_message_sid', `${scenario}:${input.action}`, {
      id: randomUUID(), conversation_id: conversation, tenant_id: tenant, direction: 'inbound', body: input.action, twilio_message_sid: `${scenario}:${input.action}`,
    })
    if (input.action === 'initial') {
      work.durableAfter(async () => { await enqueue('intake', 'intake', { action: 'initial' }, `intake:${conversation}`);await gate('before-unlock') })
    } else {
      await checked(fenced.from('sms_conversations').update({ latest_action: input.action }).eq('id', conversation))
      const replies = {correction:'Fixture correction recorded.','price-question':'Fixture price question recorded for tradie review.',resend:'Fixture previously approved quote link.'}
      await deliver(input.action, replies[input.action])
      await remote('event', { scenario, kind: 'processed', key: input.action })
    }
    return Response.json({ ok: true })
  },
  async intake() {
    const facts = await work.smsWorkCheckpoint('facts', async () => { await remote('event', { scenario, kind: 'model', key: 'facts' }); return { quantity: 2 } })
    const intake = await savedRow('intakes', 'sms_source_key', `sms:${conversation}`, { id: randomUUID(), sms_source_key: `sms:${conversation}`, scope: facts })
    await gate('intake')
    await work.smsWorkCheckpoint('intake_saved', async () => intake.id)
    work.durableAfter(async () => { await enqueue('estimate', 'estimate', { intakeId: intake.id }, `estimate:${intake.id}`) })
    return Response.json({ intakeId: intake.id })
  },
  async estimate(request) {
    const { intakeId } = await request.json()
    const price = await work.smsWorkCheckpoint('price', async () => { await remote('event', { scenario, kind: 'model', key: 'price' }); return 12345 })
    const quote = await savedRow('quotes', 'estimate_request_key', `initial:${intakeId}`, {
      id: randomUUID(), intake_id: intakeId, estimate_request_key: `initial:${intakeId}`, status: 'awaiting_tradie_approval', total_ex_gst: price,
    })
    await gate('quote')
    await gate('during-draft')
    await work.smsWorkCheckpoint('quote_saved', async () => quote.id)
    await checked(fenced.from('sms_conversations').update({ quote_id: quote.id, quote_stage: 'awaiting_review', status: 'done' }).eq('id', conversation))
    await deliver('initial-status', 'Fixture draft saved, awaiting tradie review.')
    return Response.json({ quoteId: quote.id })
  },
}
async function main() {
  if (mode === 'receipt') { await enqueue('inbound', 'initial', { action: 'initial' }); await gate('receipt'); return }
  if (mode === 'enqueue') {
    const action = boundary
    const jobs = await Promise.all(Array.from({ length: 8 }, () => followupSerial
      ? work.enqueueSmsWork({key:`${scenario}:${action}`,kind:'inbound',serialKey:followupSerial,tenantId:tenant,payload:payload({action})},db)
      : enqueue('inbound', action, { action })))
    process.send?.({ event: 'enqueued', ids: jobs.map(job => job.id) })
    return
  }
  const results = await work.runSmsWorkBatch(mode === 'inbound-only' ? {inbound:handlers.inbound} : handlers, { db, limit: 25, attemptTimeoutMs: 20000,
    scope: (job, operation) => context.withSmsDeliveryContext({ workId: job.id, workOwner: job.owner_token, turnId: job.turn_id,
      tenantId: tenant, conversationId: conversation, assertOwnership: work.assertSmsWorkOwnership }, operation) })
  if (results.some(result => !result.ok)) throw new Error(JSON.stringify(results))
  process.send?.({ event: 'complete', results })
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
