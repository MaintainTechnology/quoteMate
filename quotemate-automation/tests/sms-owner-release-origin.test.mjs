import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ tables: {}, unexpected: [], outbound: [], rpc: [], readFailure: null }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  from(table) {
    if (!(table in h.tables)) { h.unexpected.push(`table:${table}`); throw new Error(`Unregistered ${table}`) }
    const filters = []; let action = 'select', payload, single = false
    const q = { select: () => q, eq: (key, value) => { filters.push(row => row[key] === value); return q },
      is: (key, value) => { filters.push(row => (row[key] ?? null) === value); return q },
      not: (key, op, value) => {
        if (key === 'request_key' && op === 'like' && value === 'sms-correction:%') { filters.push(row => !String(row[key] ?? '').startsWith('sms-correction:')); return q }
        if (op !== 'is' || value !== null) { h.unexpected.push('not'); throw new Error('Unsupported not') }; filters.push(row => row[key] != null); return q },
      in: (key, values) => { filters.push(row => values.includes(row[key])); return q },
      or: value => { const terms = value.split(',').map(term => term.split('.eq.')); filters.push(row => terms.some(([key,expected]) => row[key] === expected)); return q },
      limit: () => q, order: () => q, maybeSingle: () => { single = true; return q }, single: () => { single = true; return q },
      insert: value => { action = 'insert'; payload = value; return q }, update: value => { action = 'update'; payload = value; return q },
      then(resolve, reject) { return Promise.resolve().then(() => {
        if (h.readFailure === table) return { data: null, error: { code: '08006' } }
        let rows = h.tables[table].filter(row => filters.every(filter => filter(row)))
        if (action === 'update') rows.forEach(row => Object.assign(row, payload))
        if (action === 'insert') { h.tables[table].push(payload); rows = [payload] }
        return { data: single ? rows[0] ?? null : rows, error: null }
      }).then(resolve, reject) },
    }; return q
  },
  async rpc(name, args) {
    h.rpc.push({ name, args })
    if (name === 'sms_release_quote_resource') return { data: { token: 'owned_paint_quote_token', customer_phone: '+61411111111' }, error: null }
    if (name === 'approve_generic_quote_release') return { data: { approved: true, outbound: args.p_outbound, outbox_id: 'outbox-1' }, error: null }
    h.unexpected.push(`rpc:${name}`); throw new Error(`Unregistered ${name}`)
  },
}) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async () => ({ identity: { userId: 'fixture-owner' }, tenant: h.tables.tenants[0] }) }))
vi.mock('@/lib/sms/dispatch', () => ({ dispatchQuoteMessage: async options => { h.outbound.push(options); return { ok: true, sid: 'SM-fixture', channel: 'sms', status: 'queued' } } }))
vi.mock('@/lib/quote/pdf', () => ({ ensureQuotePdf: async () => null, signQuotePdfUrl: async () => { h.unexpected.push('signed-media'); throw new Error('Unexpected media') } }))
vi.mock('next/server', () => ({ after: () => {} }))
import { POST as approveTrade } from '@/app/api/sms/quote-release/route'
import { POST as approveGeneric } from '@/app/api/quote/[id]/approve/route'
import { POST as sendGeneric } from '@/app/api/quote/[id]/send/route'
import { loadSavedQuoteReview } from '@/lib/sms/quote-review'
import { quoteCustomerReleaseRevision } from '@/lib/quote/customer-release'
import { createClient } from '@supabase/supabase-js'
import { resolveQuoteOriginConversation } from '@/lib/sms/quote-origin-conversation'

const tenantId = '11111111-1111-4111-8111-111111111111', genericId = '22222222-2222-4222-8222-222222222222'
const paintId = '33333333-3333-4333-8333-333333333333', conversationId = '44444444-4444-4444-8444-444444444444'
const intakeId = '55555555-5555-4555-8555-555555555555'
beforeEach(() => {
  vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://quotemax.com.au')
  h.unexpected = []; h.outbound = []; h.rpc = []; h.readFailure = null
  h.tables = {
    tenants: [{ id: tenantId, twilio_sms_number: '+61488888888', business_name: 'Owned tradie' }],
    quotes: [{ id: genericId, tenant_id: tenantId, intake_id: intakeId, status: 'awaiting_tradie_approval', share_token: 'owned_generic_quote_token',
      better: { total_inc_gst: 550, subtotal_ex_gst: 500, line_items: [] }, good: null, best: null, selected_tier: 'better', total_inc_gst: 550 }],
    intakes: [{ id: intakeId, tenant_id: tenantId, trade: 'electrical', job_type: 'power_points', caller: { phone: '+61411111111', name: 'Sam' } }],
    painting_measurements: [{ id: paintId, tenant_id: tenantId, public_token: 'owned_paint_quote_token', customer_phone: '+61411111111',
      address: '12 Example Road', released_at: null, estimate: { price: { tiers: [{ tier: 'better', inc_gst: 18648 }] } } }],
    pricing_book: [{ tenant_id: tenantId, trade: 'electrical', quote_tier_mode: 'single' }],
    job_quote_operations: [], sms_work_jobs: [], quote_followup_events: [], sms_human_tasks: [], plan_upload_requests: [],
    sms_conversations: [{ id: conversationId, tenant_id: tenantId, from_number: '+61411111111', to_number: '+61488888888', status: 'done' }],
  }
  vi.stubGlobal('fetch', async () => { h.unexpected.push('fetch'); throw new Error('External IO prohibited') })
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
async function approve(family) {
  const id = family === 'generic' ? genericId : paintId
  const version = family === 'generic' ? quoteCustomerReleaseRevision(h.tables.quotes[0])
    : (await loadSavedQuoteReview(createClient(), tenantId, 'paint', id)).version
  const request = new Request('https://quotemax.com.au/api/approval-fixture', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(family === 'generic' ? { expected_revision: version } : { family, id, approve: true, reviewVersion: version }) })
  return family === 'generic' ? approveGeneric(request, { params: Promise.resolve({ id }) }) : approveTrade(request)
}
describe('actual owner approval keeps a proven SMS origin', () => {
  it('filters many correction followups before the bounded creation-origin read', async () => {
    h.tables.sms_human_tasks.push({ tenant_id: tenantId, resource_type: 'paint', resource_id: paintId,
      request_key: `paint:${paintId}:review`, customer_phone: '+61411111111', conversation_id: conversationId })
    for (let index = 0; index < 30; index++) h.tables.sms_human_tasks.push({ tenant_id: tenantId,
      resource_type: 'paint', resource_id: paintId, request_key: `sms-correction:SM-${index}`,
      customer_phone: '+61411111111', conversation_id: '66666666-6666-4666-8666-666666666666' })
    expect((await approve('paint')).status).toBe(200)
    expect(h.outbound[0].conversationId).toBe(conversationId)
    expect(h.unexpected).toEqual([])
  })
  it.each(['generic', 'paint'])('%s: a correction from another conversation does not replace the original creation origin', async family => {
    const id = family === 'generic' ? genericId : paintId
    h.tables.sms_human_tasks.push({ tenant_id: tenantId, resource_type: family, resource_id: id,
      request_key: `${family}:${id}:review`, customer_phone: '+61411111111', conversation_id: conversationId })
    const followup = '66666666-6666-4666-8666-666666666666'
    h.tables.sms_conversations.push({ id: followup, tenant_id: tenantId, from_number: '+61411111111', to_number: '+61488888888' })
    h.tables.sms_human_tasks.push({ tenant_id: tenantId, resource_type: family, resource_id: id,
      request_key: 'sms-correction:SM-new-conversation', customer_phone: '+61411111111', conversation_id: followup })
    expect((await approve(family)).status).toBe(200)
    expect(h.outbound[0].conversationId).toBe(conversationId)
    if (family === 'generic') {
      h.tables.quotes[0].status = 'sent'; h.tables.quotes[0].customer_released_at = new Date().toISOString()
      const response = await sendGeneric(new Request('https://quotemax.com.au/api/quote/send', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'sms' }) }), { params: Promise.resolve({ id: genericId }) })
      expect(response.status).toBe(200)
      expect(h.outbound.at(-1).conversationId).toBe(conversationId)
    }
    expect(h.unexpected).toEqual([])
  })
  it.each(['generic', 'paint'])('%s: initial accepted intent retains its owned quote review conversation', async family => {
    h.tables.sms_human_tasks.push({ tenant_id: tenantId, resource_type: family, resource_id: family === 'generic' ? genericId : paintId,
      customer_phone: '0411 111 111', conversation_id: conversationId })
    const response = await approve(family)
    expect(response.status).toBe(200)
    expect(h.outbound).toHaveLength(1)
    expect(h.outbound[0].conversationId).toBe(conversationId)
    expect(h.rpc[0].args.p_outbound.conversationId).toBe(conversationId)
    expect(h.unexpected).toEqual([])
  })
  it.each(['generic', 'paint'])('%s: a portal resource with no origin stays outbox-only', async family => {
    expect((await approve(family)).status).toBe(200)
    expect(h.outbound[0].conversationId).toBeUndefined()
    expect(h.unexpected).toEqual([])
  })
  it('finds a legacy generic origin through its exact owned intake relationship', async () => {
    h.tables.sms_conversations[0].intake_id = intakeId
    expect((await approve('generic')).status).toBe(200)
    expect(h.outbound[0].conversationId).toBe(conversationId)
    expect(h.unexpected).toEqual([])
  })
  for (const family of ['generic','paint']) {
    it.each(['task-customer','conversation-customer','conversation-tenant','tradie-number','ambiguous','read-failure'])(`${family}: fails before creating an intent when origin is %s`, async failure => {
      const task = { tenant_id: tenantId, resource_type: family, resource_id: family === 'generic' ? genericId : paintId,
        customer_phone: '+61411111111', conversation_id: conversationId }
      h.tables.sms_human_tasks.push(task)
      if (failure === 'task-customer') task.customer_phone = '+61433333333'
      if (failure === 'conversation-customer') h.tables.sms_conversations[0].from_number = '+61433333333'
      if (failure === 'conversation-tenant') h.tables.sms_conversations[0].tenant_id = '99999999-9999-4999-8999-999999999999'
      if (failure === 'tradie-number') h.tables.sms_conversations[0].to_number = '+61433333333'
      if (failure === 'ambiguous') h.tables.sms_human_tasks.push({ ...task, conversation_id: '66666666-6666-4666-8666-666666666666' })
      if (failure === 'read-failure') h.readFailure = 'sms_human_tasks'
      expect((await approve(family)).status).toBe(503)
      expect(h.rpc).toEqual([]); expect(h.outbound).toEqual([]); expect(h.unexpected).toEqual([])
    })
  }
  it('finds a plan origin only through its owned upload-request relation', async () => {
    h.tables.plan_upload_requests.push({ tenant_id: tenantId, plan_extraction_id: paintId, customer_phone: '+61411111111', sms_conversation_id: conversationId })
    expect(await resolveQuoteOriginConversation(createClient(), { tenantId, family: 'plan', resourceId: paintId,
      customerPhone: '+61411111111', fromNumber: '+61488888888' })).toBe(conversationId)
    expect(h.unexpected).toEqual([])
  })
  it.each([undefined, '0411 111 111'])('manual send retains the proven origin for the original customer (%s)', async to => {
    h.tables.sms_conversations[0].quote_id = genericId
    const request = new Request('https://quotemax.com.au/api/manual-send', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'sms', to,
        expected_revision: quoteCustomerReleaseRevision(h.tables.quotes[0]) }) })
    expect((await sendGeneric(request, { params: Promise.resolve({ id: genericId }) })).status).toBe(200)
    expect(h.outbound).toHaveLength(1)
    expect(h.outbound[0].conversationId).toBe(conversationId)
    expect(h.rpc[0].args.p_outbound.conversationId).toBe(conversationId)
    expect(h.unexpected).toEqual([])
  })
  it('manual send to an explicitly different recipient stays unattached to the original conversation', async () => {
    h.tables.sms_conversations[0].quote_id = genericId
    const request = new Request('https://quotemax.com.au/api/manual-send', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'sms', to: '0433 333 333',
        expected_revision: quoteCustomerReleaseRevision(h.tables.quotes[0]) }) })
    expect((await sendGeneric(request, { params: Promise.resolve({ id: genericId }) })).status).toBe(200)
    expect(h.outbound).toHaveLength(1)
    expect(h.outbound[0].to).toBe('+61433333333')
    expect(h.outbound[0].conversationId).toBeUndefined()
    expect(h.rpc[0].args.p_outbound.conversationId).toBeUndefined()
    expect(h.unexpected).toEqual([])
  })
  it('manual send fails before creating an intent when its original conversation belongs to another tenant', async () => {
    h.tables.sms_human_tasks.push({ tenant_id: tenantId, resource_type: 'generic', resource_id: genericId,
      customer_phone: '+61411111111', conversation_id: conversationId })
    h.tables.sms_conversations[0].tenant_id = '99999999-9999-4999-8999-999999999999'
    const request = new Request('https://quotemax.com.au/api/manual-send', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'sms',
        expected_revision: quoteCustomerReleaseRevision(h.tables.quotes[0]) }) })
    expect((await sendGeneric(request, { params: Promise.resolve({ id: genericId }) })).status).toBe(503)
    expect(h.rpc).toEqual([]); expect(h.outbound).toEqual([]); expect(h.unexpected).toEqual([])
  })
})
