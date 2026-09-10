import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assertExpectedQuoteRecipient, resolveOwnedQuoteCustomerContact } from './delivery-recipient'

type Row = Record<string, unknown>
const tenant = 'tenant-a'
const intake = { id: 'intake-a', tenant_id: tenant, caller: null, call_id: 'call-a', customer_id: 'customer-a' }
function dbFixture(rows: Record<string, Row[]>, failure?: string) {
  const queries: { table: string; filters: Record<string, unknown> }[] = []
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {}
    queries.push({ table, filters })
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters[key] = value; return query },
      order: () => query, limit: () => query,
      maybeSingle: async () => ({
        data: rows[table]?.find(row => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null,
        error: failure === table ? { message: 'Database unavailable' } : null,
      }),
    }
    return query
  })
  return { db: { from } as unknown as SupabaseClient, queries, from }
}

describe('reviewed quote recipient proof', () => {
  it('accepts the actual AU destination across existing supported display formats', () => {
    for (const value of ['0411 222 333', '61411222333', '+61411222333'])
      expect(() => assertExpectedQuoteRecipient('sms', value, '+61411222333')).not.toThrow()
  })
  it('keeps stored international recipients exact without changing their send policy', () => {
    expect(() => assertExpectedQuoteRecipient('sms', '+64 21 123 456', '+64 21 123 456')).not.toThrow()
    expect(() => assertExpectedQuoteRecipient('sms', '+64 21 123 456', '+64 21 123 457')).toThrow('recipient changed')
  })
  it('normalizes email domain only and rejects a changed email local part', () => {
    expect(() => assertExpectedQuoteRecipient('email', ' Customer@EXAMPLE.COM ', 'Customer@example.com')).not.toThrow()
    expect(() => assertExpectedQuoteRecipient('email', 'Customer@example.com', 'Other@example.com')).toThrow('recipient changed')
    expect(() => assertExpectedQuoteRecipient('email', 'Customer@example.com', 'customer@example.com')).toThrow('recipient changed')
  })
  it.each([null, '', ' ', 1, false, {}, '\n+61411222333'])('rejects supplied invalid proof %j instead of opting out', value => {
    expect(() => assertExpectedQuoteRecipient('sms', value, '+61411222333')).toThrow('Review a customer recipient')
  })
  it('retains legacy omitted-proof compatibility but rejects changed or absent resolved destinations', () => {
    expect(() => assertExpectedQuoteRecipient('sms', undefined, '+61411222333')).not.toThrow()
    expect(() => assertExpectedQuoteRecipient('sms', '+61411222333', '+61411222334')).toThrow('recipient changed')
    expect(() => assertExpectedQuoteRecipient('sms', '+61411222333', null)).toThrow('recipient changed')
  })
})

describe('owned contact reads before customer dispatch', () => {
  it('uses populated owned caller fields without querying lower-priority sources', async () => {
    const fixture = dbFixture({})
    await expect(resolveOwnedQuoteCustomerContact(fixture.db, tenant, {
      ...intake, caller: { phone: '+61411222333', email: 'customer@example.com' },
    })).resolves.toEqual({ phone: '+61411222333', email: 'customer@example.com' })
    expect(fixture.from).not.toHaveBeenCalled()
  })
  it('keeps SMS, call, then customer precedence and applies tenant filters to every source', async () => {
    const fixture = dbFixture({
      sms_conversations: [{ id: 'sms-a', intake_id: intake.id, tenant_id: tenant, from_number: '+61411222333' }],
      calls: [{ id: 'call-a', tenant_id: tenant, caller_number: '+61411222334' }],
      customers: [{ id: 'customer-a', tenant_id: tenant, phone_number: '+61411222335', email: 'customer@example.com' }],
    })
    await expect(resolveOwnedQuoteCustomerContact(fixture.db, tenant, intake)).resolves.toEqual({
      phone: '+61411222333', email: 'customer@example.com',
    })
    expect(fixture.queries.map(query => query.table)).toEqual(['sms_conversations', 'customers'])
    expect(fixture.queries.every(query => query.filters.tenant_id === tenant)).toBe(true)
  })
  it.each(['sms_conversations', 'calls', 'customers'])('fails closed on an unreadable %s source without switching recipients', async failure => {
    const fixture = dbFixture({
      customers: [{ id: 'customer-a', tenant_id: tenant, phone_number: '+61411222335', email: 'customer@example.com' }],
    }, failure)
    await expect(resolveOwnedQuoteCustomerContact(fixture.db, tenant, intake)).rejects.toMatchObject({
      code: 'quote_contact_unavailable', status: 503,
    })
    expect(fixture.queries.at(-1)?.table).toBe(failure)
  })
  it('never reads a foreign intake or accepts foreign fallback records', async () => {
    const fixture = dbFixture({
      sms_conversations: [{ id: 'sms-b', intake_id: intake.id, tenant_id: 'tenant-b', from_number: '+61411222333' }],
      customers: [{ id: 'customer-a', tenant_id: 'tenant-b', phone_number: '+61411222335', email: 'other@example.com' }],
    })
    await expect(resolveOwnedQuoteCustomerContact(fixture.db, tenant, { ...intake, tenant_id: 'tenant-b' })).rejects.toMatchObject({ status: 503 })
    expect(fixture.from).not.toHaveBeenCalled()
    await expect(resolveOwnedQuoteCustomerContact(fixture.db, tenant, intake)).resolves.toEqual({ phone: null, email: null })
  })
  it('rejects malformed contact metadata instead of coercing a different recipient', async () => {
    const fixture = dbFixture({})
    await expect(resolveOwnedQuoteCustomerContact(fixture.db, tenant, { ...intake, caller: { phone: 411222333 } })).rejects.toMatchObject({ status: 503 })
    expect(fixture.from).not.toHaveBeenCalled()
  })
})
