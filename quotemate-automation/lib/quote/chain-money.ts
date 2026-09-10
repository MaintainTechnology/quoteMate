import type { SupabaseClient } from '@supabase/supabase-js'
import { isSiteVisitFirstTrade } from './mint-tier'
import { INSPECTION_FEE_AUD_CENTS, MIN_STRIPE_CHARGE_CENTS,
  finalDepositBaseCents, finalBalanceBaseCents, surchargeCents, chargedCents } from './money'

type Row = Record<string, unknown>
type Kind = 'initial' | 'final' | 'balance' | null
function kind(row: Row | null): Kind {
  if (!row) return null
  return row.quote_kind == null || row.quote_kind === 'initial' ? 'initial'
    : row.quote_kind === 'final' || row.quote_kind === 'balance' ? row.quote_kind : null
}
export function storedMoneyCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  const cents = Math.round(value * 100)
  return Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < 0.000001 ? cents : null
}
export function storedDepositPercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 90 ? value : null
}

/** Shared owner preview / public payment proof. Missing history never becomes an assumed credit. */
export function quoteChainMoney(quote: Row, quoteKind: Kind, parent: Row | null, root: Row | null, trade: string | null) {
  const final = quoteKind === 'final' ? quote : quoteKind === 'balance' ? parent : null
  const sameJob = (row: Row | null) => !!row && row.tenant_id === quote.tenant_id && row.intake_id === quote.intake_id
  const validRoot = sameJob(root) && kind(root) === 'initial' && root!.parent_quote_id == null
  const validFinal = !!final && kind(final) === 'final' && sameJob(final) && final.parent_quote_id === root?.id
  const creditProven = validRoot && !!root!.paid_at && root!.paid_tier === 'inspection' && isSiteVisitFirstTrade(trade)
  const finalTotal = storedMoneyCents(final?.total_inc_gst)
  const pct = storedDepositPercent(final?.deposit_pct)
  const financialContext = creditProven && validFinal && finalTotal !== null && pct !== null
  const depositBase = financialContext ? finalDepositBaseCents(finalTotal, pct) : null
  const balanceBase = financialContext ? finalBalanceBaseCents(finalTotal, pct) : null
  const storedBalance = quoteKind === 'balance' ? storedMoneyCents(quote.total_inc_gst) : null
  const balanceConsistent = quoteKind !== 'balance' || (quote.parent_quote_id === final?.id &&
    storedBalance !== null && storedBalance === balanceBase && quote.deposit_pct === pct)
  const settledFinal = !!final?.sent_at && !!final.paid_at && depositBase !== null &&
    ((final.paid_tier === 'credit' && depositBase < MIN_STRIPE_CHARGE_CENTS) ||
      (final.paid_tier === 'deposit' && depositBase >= MIN_STRIPE_CHARGE_CENTS))
  // A credit stamp represents only a deposit below the collection threshold;
  // it cannot prove payment of a larger deposit on a corrupted/changed final.
  const available = financialContext && balanceConsistent && (!final?.paid_at || settledFinal) &&
    (quoteKind !== 'balance' || settledFinal)
  const currentBase = !quote.paid_at && available
    ? quoteKind === 'final' ? depositBase : quoteKind === 'balance' ? storedBalance : null : null
  const collectable = currentBase !== null && currentBase >= MIN_STRIPE_CHARGE_CENTS ? currentBase : null
  return {
    available, balanceBase, finalTotal, depositPercent: pct,
    money: {
      currency: 'AUD' as const, unit: 'cents' as const, source: 'stored_quote_chain' as const,
      job_total_inc_gst_cents: available ? finalTotal : null,
      inspection_credit_cents: creditProven ? INSPECTION_FEE_AUD_CENTS : null,
      deposit_base_cents: available ? depositBase : null,
      balance_base_cents: available ? balanceBase : null,
      current_payment_base_cents: collectable,
      platform_fee_cents: collectable === null ? null : surchargeCents(collectable),
      customer_charge_cents: collectable === null ? null : chargedCents(collectable),
    },
  }
}

export class QuoteChainMoneyError extends Error {
  constructor(public readonly status: 409 | 503) {
    super(status === 503 ? 'quote_chain_unavailable' : 'quote_chain_not_payable')
    this.name = 'QuoteChainMoneyError'
  }
}
const PARENT_FIELDS = 'id,tenant_id,intake_id,quote_kind,parent_quote_id,paid_at,paid_tier,sent_at,total_inc_gst,deposit_pct'
export async function loadChildQuoteMoney(db: SupabaseClient, quote: Row, trade: string | null) {
  const quoteKind = kind(quote)
  if ((quoteKind !== 'final' && quoteKind !== 'balance') || typeof quote.tenant_id !== 'string' ||
      typeof quote.intake_id !== 'string') throw new QuoteChainMoneyError(409)
  const ancestor = async (id: unknown) => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new QuoteChainMoneyError(409)
    const { data, error } = await db.from('quotes').select(PARENT_FIELDS)
      .eq('id', id).eq('tenant_id', quote.tenant_id as string).maybeSingle<Row>()
    if (error) throw new QuoteChainMoneyError(503)
    if (!data || data.id !== id || data.tenant_id !== quote.tenant_id || data.intake_id !== quote.intake_id) {
      throw new QuoteChainMoneyError(409)
    }
    return data
  }
  const parent = await ancestor(quote.parent_quote_id)
  const root = quoteKind === 'final' ? parent : await ancestor(parent.parent_quote_id)
  const proof = quoteChainMoney(quote, quoteKind, parent, root, trade)
  if (!proof.available || proof.money.current_payment_base_cents === null || proof.depositPercent === null) {
    throw new QuoteChainMoneyError(409)
  }
  return proof
}
