import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import type { SupabaseClient } from '@supabase/supabase-js'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { resolveOwnedQuoteCustomerContact } from '@/lib/quote/delivery-recipient'

type Row = Record<string, unknown>
type Element = { type: unknown; props: Record<string, unknown> }
function genericApprovalPageFixture(options: { phone?: string | null; source?: 'caller' | 'sms'; fail?: string; owner?: boolean } = {}) {
  const queries: { table: string; fields: string; filters: Row }[] = []
  const unexpected: string[] = []
  const phone = options.phone === undefined ? '0411 222 333' : options.phone
  const rows: Record<string, Row[]> = {
    quotes: [{ id: 'quote-1', tenant_id: 'tenant-1', intake_id: 'intake-1', share_token: 'saved-token', status: 'awaiting_tradie_approval', total_inc_gst: 1100 }],
    intakes: [{ id: 'intake-1', tenant_id: 'tenant-1', caller: { name: 'Sam', phone: options.source === 'sms' ? null : phone }, call_id: null, customer_id: null }],
    sms_conversations: [
      { id: 'foreign', tenant_id: 'tenant-2', intake_id: 'intake-1', from_number: '+61499999999' },
      ...(options.source === 'sms' && phone ? [{ id: 'conversation-1', tenant_id: 'tenant-1', intake_id: 'intake-1', from_number: phone }] : []),
    ],
  }
  const db = {
    from(table: string) {
      if (!(table in rows)) { unexpected.push(table); throw new Error(`Unexpected table ${table}`) }
      const record = { table, fields: '', filters: {} as Row }; queries.push(record)
      const query = {
        select(fields: string) { record.fields = fields; return query },
        eq(key: string, value: unknown) { record.filters[key] = value; return query },
        order() { return query }, limit() { return query },
        async maybeSingle() {
          if (options.fail === table) return { data: null, error: { message: 'Fixture dependency failure' } }
          return { data: rows[table].find(row => Object.entries(record.filters).every(([key, value]) => row[key] === value)) ?? null, error: null }
        },
      }
      return query
    },
  }
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props })
  const approveAction = () => null
  const exports: Record<string, unknown> = {}
  const code = ts.transpileModule(readFileSync('app/q/[token]/approve/page.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(code, {
    exports, module: { exports }, process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://offline.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture-only' } },
    require(name: string) {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === '@supabase/supabase-js') return { createClient: () => db }
      if (name === '@/lib/quote/delivery-recipient') return { resolveOwnedQuoteCustomerContact: (client: SupabaseClient, tenantId: string, intake: Row | null) => resolveOwnedQuoteCustomerContact(client, tenantId, intake) }
      if (name === '@/lib/quote/customer-release') return { quoteCustomerReleaseRevision: () => 'reviewed-revision' }
      if (name === '@/lib/quote/page-owner') return { isQuotePageOwner: async () => options.owner !== false }
      if (name === '@/app/q/_chrome/QuoteAwaitingReview') return { QuoteAwaitingReview: 'HeldPage' }
      if (name === 'next/link') return { default: 'a' }
      if (name === 'next/navigation') return { notFound: () => { throw new Error('notFound') } }
      if (name === '../../_chrome/TradieDashboardPill') return { TradieDashboardPill: 'DashboardPill' }
      if (name === './ApproveAction') return { ApproveAction: approveAction }
      unexpected.push(name); throw new Error(`Unexpected import ${name}`)
    },
  })
  return {
    queries, unexpected, approveAction,
    render: () => (exports.default as (props: unknown) => Promise<Element>)({ params: Promise.resolve({ token: 'saved-token' }) }),
  }
}
function elements(value: unknown): Element[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(elements)
  const node = value as Element
  return [node, ...elements(node.props?.children)]
}
function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(text).join('')
  return value && typeof value === 'object' ? text((value as Element).props?.children) : ''
}

it.each(['caller', 'sms'] as const)('actual approval page shows and passes the same owned %s destination', async source => {
  const fixture = genericApprovalPageFixture({ source })
  const page = await fixture.render()
  expect(text(page)).toContain('Send customer SMS to 0411 222 333.')
  const action = elements(page).find(node => node.type === fixture.approveAction)
  expect(action?.props).toMatchObject({ customerPhone: '0411 222 333', reviewVersion: 'reviewed-revision', quoteId: 'quote-1' })
  expect(fixture.queries.find(query => query.table === 'intakes')?.filters).toEqual({ id: 'intake-1', tenant_id: 'tenant-1' })
  if (source === 'sms') expect(fixture.queries.find(query => query.table === 'sms_conversations')?.filters).toEqual({ intake_id: 'intake-1', tenant_id: 'tenant-1' })
  expect(fixture.unexpected).toEqual([])
})

it('actual approval page explicitly passes missing contact rather than inventing a recipient', async () => {
  const fixture = genericApprovalPageFixture({ phone: null })
  const page = await fixture.render()
  expect(text(page)).toContain('No customer mobile is available')
  expect(elements(page).find(node => node.type === fixture.approveAction)?.props.customerPhone).toBeNull()
  expect(fixture.unexpected).toEqual([])
})

it.each(['intakes', 'sms_conversations'])('actual approval page cannot offer send after an owned %s read failure', async fail => {
  const fixture = genericApprovalPageFixture({ source: 'sms', fail })
  const page = await fixture.render()
  expect(page.props.role).toBe('alert')
  expect(text(page)).toContain('Customer contact temporarily unavailable')
  expect(elements(page).find(node => node.type === fixture.approveAction)).toBeUndefined()
  expect(fixture.unexpected).toEqual([])
})

it('customer access cannot see the destination or execute contact lookups', async () => {
  const fixture = genericApprovalPageFixture({ owner: false })
  const page = await fixture.render()
  expect(page.type).toBe('HeldPage')
  expect(fixture.queries.map(query => query.table)).toEqual(['quotes'])
  expect(fixture.unexpected).toEqual([])
})
