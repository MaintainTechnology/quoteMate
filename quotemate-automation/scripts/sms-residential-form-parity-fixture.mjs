// Isolated adapter: reuse the real-SQL journey database without editing the
// compiled-journey harness. There are no seeded intakes, quotes or review tasks.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { createRouteFixtureDb } from './sms-route-fixture-db.mjs'
import providers from './sms-route-provider-fixtures.cjs'

export const { TENANT, BOOK, CUSTOMER, OWNER, TO, ADDRESS } = providers
export const CONVERSATION = '33333333-3333-4333-8333-333333333333'
export const FORM_TOKEN = 'residential-form-parity-token'

export function briefFor(trade) {
  assert.ok(['electrical', 'plumbing', 'roofing'].includes(trade))
  const config = providers.fixture(trade)
  config.seed.pricing_book[0].overlays.roofing_rate_card.reroof_rate_per_m2.unknown = 0
  for (const rows of Object.values(config.seed)) for (const row of rows) row.created_at = '2026-09-08T00:00:00.000Z'
  const brief = config.turns[0]
  const form = { address: { address: ADDRESS, postcode: '2000', state: 'NSW' }, first_name: 'Sam',
    contact_time: 'anytime', notes: brief,
    inputs: trade === 'electrical'
      ? { job_type: 'power_points', quantity: 2, ceiling_type: 'flat', storeys: 1, switch_within_5m: 'yes' }
      : trade === 'plumbing' ? { job_type: 'tap' }
        : { material: 'colorbond_corrugated', pitch: 'standard', intent: 'full_reroof', storeys: 1, building_year_built: 2010 } }
  // The prose states the same electrical detail as the form's explicit answer.
  if (trade === 'electrical') {
    form.notes += ' There is an existing switch within 5 m.'
    config.structure.scope.description = form.notes
  }
  return { config, brief: form.notes, form }
}

/** Only the model/provider boundary is scripted. It refuses incomplete/different
 * facts, wrong trade hints and unregistered model operations before emitting data. */
export function strictModel(spec, lane, record, unexpected) {
  const base = providers.createModelProvider(spec.config, record)
  return {
    async generateObject(options) {
      try {
        assert.deepEqual(Object.keys(options.schema.shape).filter(key => ['scope','caller'].includes(key)).sort(), ['caller','scope'])
        const prompt = JSON.stringify(options.messages)
        assert.ok(prompt.includes(spec.brief), 'Actual structurer transcript must contain the complete common brief')
        assert.ok(options.system.includes(`extract structured intake data from ${spec.config.trade} quoting calls`), 'Actual trade hint must select the correct system prompt')
        if (lane === 'form') {
          assert.ok(prompt.includes(`Quote request form (${spec.config.trade})`))
          assert.ok(prompt.includes('Name: Sam'))
          assert.ok(prompt.includes(`Address: ${ADDRESS}, NSW 2000`))
          if (spec.config.trade === 'electrical') {
            for (const text of ['How many: 2','Storeys: Single storey','Existing switch within 5 m: Yes']) assert.ok(prompt.includes(text), `Missing real form fact: ${text}`)
          }
        } else assert.ok(!prompt.includes('Quote request form ('), 'SMS lane must use its own customer transcript')
        return await base.generateObject(options)
      } catch (error) { throw unexpected(`Model fixture: ${error.message}`) }
    },
    async generateText(options) {
      try {
        assert.ok(options.tools?.applyMarkup, 'Only actual money-tool estimation is admitted')
        const prompt = JSON.stringify(options.messages ?? options.prompt)
        assert.ok(prompt.includes(spec.brief), 'Estimator must receive the actual structured common brief')
        return await base.generateText(options)
      } catch (error) { throw unexpected(`Model fixture: ${error.message}`) }
    },
  }
}

export async function createResidentialFixture(app, spec, lane, unexpected) {
  const store = await createRouteFixtureDb(app)
  try {
  // Declare only columns needed by the real SQL contracts, without inserting
  // placeholder results. Dynamic fixture columns cannot certify remote schema.
  await store.pg.exec(`alter table quotes add column if not exists customer_released_at timestamptz;
    alter table sms_messages add column if not exists photo_urls jsonb, add column if not exists photo_paths jsonb;
    alter table sms_conversations add column if not exists intake_id uuid, add column if not exists quote_id uuid,
      add column if not exists quote_stage text, add column if not exists updated_at timestamptz;
    alter table roofing_measurements add column if not exists postcode text, add column if not exists state text;`)
  const run = async operation => {
    try { return await operation() }
    catch (error) { unexpected(`Fixture DB: ${error.message}`); return { data: null, error: { code: error.code ?? 'FIXTURE', message: error.message } } }
  }
  const deferred = operation => {
    let promise
    const thenable = { abortSignal: () => thenable,
      then: (yes, no) => (promise ??= run(operation)).then(yes, no) }
    return thenable
  }
  const client = {
    rpc: (name, args = {}) => deferred(() => store.rpc({ name, args })),
    from(table) {
      const input = { table, action: 'select', filters: [], orders: [] }
      const query = { ...deferred(() => store.query(input)),
        select: (columns = '*', options = {}) => { input.columns = columns; input.head = options.head; return query },
        insert: payload => { input.action = 'insert'; input.payload = payload; return query },
        update: payload => { input.action = 'update'; input.payload = payload; return query },
        upsert: (payload, options = {}) => { input.action = 'upsert'; input.payload = payload; input.conflict = options.onConflict; input.ignoreDuplicates = options.ignoreDuplicates; return query },
        delete: () => { input.action = 'delete'; return query },
        order: (key, options = {}) => { input.orders.push({ key, ...options }); return query },
        limit: limit => { input.limit = limit; return query },
        single: () => { input.single = 'single'; return query },
        maybeSingle: () => { input.single = 'maybeSingle'; return query },
        abortSignal: () => query,
      }
      for (const op of ['eq','neq','gte','lte','gt','lt','is','in','contains','like','ilike']) query[op] = (key, value) => { input.filters.push({ op, key, value }); return query }
      query.or = value => { input.filters.push({ op: 'or', value }); return query }
      query.not = (key, op, value) => { input.filters.push({ key, op, value, negated: true }); return query }
      query.filter = (key, op, value) => { input.filters.push({ key, op, value }); return query }
      return query
    },
    storage: { from: () => new Proxy({}, { get: (_, method) => () => { throw unexpected(`Unexpected storage ${String(method)}`) } }) },
  }
  for (const [table, rows] of Object.entries(spec.config.seed)) await store.seed(table, rows)
  await store.seed('sms_conversations', [{ id: CONVERSATION, tenant_id: TENANT, from_number: CUSTOMER, to_number: TO,
    status: 'open', conversation_state: { slots: lane === 'sms' ? { ...spec.config.slots } : {} },
    assumptions_made: [], photo_request_sent_at: '2026-09-08T00:00:00.000Z', lead_push_sent_at: '2026-09-08T00:00:00.000Z' }])
  if (lane === 'form') await store.seed('trade_lead_requests', [{ token: FORM_TOKEN, trade: spec.config.trade,
    tenant_id: TENANT, conversation_id: CONVERSATION, customer_phone: CUSTOMER, status: 'pending' }])
  else await store.seed('sms_messages', [{ conversation_id: CONVERSATION, direction: 'inbound', body: spec.brief,
    twilio_message_sid: 'SM11111111111111111111111111111111' }])
  return { ...store, client }
  } catch (error) {
    // Initialisation can fail before the caller receives this handle.
    await store.close()
    throw error
  }
}

/** Source binding follows statically resolvable local imports of the exercised
 * entries (not computed runtime module names). External package versions remain
 * tied to the local package lock; this is not a deployed image attestation. */
export function sourceHashes(app, entries) {
  const files = new Set()
  const visit = path => {
    const file = resolve(app, path)
    assert.ok(file.startsWith(resolve(app) + '\\') || file.startsWith(resolve(app) + '/'), `Outside source root: ${path}`)
    if (files.has(file)) return
    files.add(file)
    if (!/\.[cm]?[jt]sx?$/.test(file)) return
    const text = readFileSync(file, 'utf8')
    const imports = [...text.matchAll(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\()\s*['"]([^'"]+)['"]/g)].map(match => match[1])
    for (const name of imports) {
      if (!name.startsWith('.') && !name.startsWith('@/')) continue
      const base = name.startsWith('@/') ? join(app, name.slice(2)) : resolve(dirname(file), name)
      const child = [base, ...['.ts','.tsx','.mjs','.cjs','.js','.json','/index.ts','/index.tsx'].map(ext => base + ext)].find(candidate => existsSync(candidate) && /\.[cm]?[jt]sx?$|\.json$/.test(candidate))
      assert.ok(child, `Unresolved local source import ${path}: ${name}`)
      visit(relative(app, child))
    }
  }
  entries.forEach(visit)
  return Object.fromEntries([...files].sort().map(file => [relative(app, file).replaceAll('\\','/'), createHash('sha256').update(readFileSync(file)).digest('hex')]))
}
