import { describe, expect, it } from 'vitest'
import { quoteChainMoney } from './chain-money'
const root = { id: 'root', tenant_id: 'a', intake_id: 'i', quote_kind: 'initial', paid_at: 'paid', paid_tier: 'inspection' }
const final = { id: 'final', tenant_id: 'a', intake_id: 'i', quote_kind: 'final', parent_quote_id: 'root', paid_at: 'paid', sent_at: 'sent', paid_tier: 'deposit', total_inc_gst: 1000, deposit_pct: 30 }
describe('shared owner/payment settlement proof', () => {
  it.each([
    ['credit', 1000, false], ['credit', 300, true], ['deposit', 1000, true], ['deposit', 300, false],
    ['credit', 331.64, true], ['credit', 331.67, false], ['deposit', 331.67, true], ['inspection', 1000, false],
  ])('validates %s against the actual deposit for total%s', (paid_tier, total_inc_gst, available) => {
    const q = { ...final, paid_tier, total_inc_gst }
    const proof = quoteChainMoney(q, 'final', root, root, 'electrical')
    expect(proof.available).toBe(available)
    const child = { id: 'balance', tenant_id: 'a', intake_id: 'i', quote_kind: 'balance', parent_quote_id: 'final', total_inc_gst: (proof.balanceBase ?? 0) / 100, deposit_pct: 30 }
    expect(quoteChainMoney(child, 'balance', q, root, 'electrical').available).toBe(available)
  })
  it('still permits an unpaid final draft to show its deposit amount', () => {
    expect(quoteChainMoney({ ...final, paid_at: null, paid_tier: null, sent_at: null }, 'final', root, root, 'electrical'))
      .toMatchObject({ available: true, money: { current_payment_base_cents: 20100 } })
  })
})
