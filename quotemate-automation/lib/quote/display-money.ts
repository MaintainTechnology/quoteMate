import { clampDiscountPct } from './early-bird'
import { totalIncGstCents, type MoneyOpts } from './money'

/** Presentation of already validated quote money; preserve every charged cent. */
export function quoteAmount(cents: number): number { return cents / 100 }
export function formatQuoteAmount(amount: number): string {
  return amount.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
export function quotePriceStack(ex: number | string, opts: MoneyOpts & { gstRegistered: boolean }) {
  const base = Number(ex)
  const discountPct = clampDiscountPct(opts.discountPct)
  const baseCents = Math.round(base * 100)
  const netCents = Math.round(base * (1 - discountPct / 100) * 100)
  const totalCents = totalIncGstCents(ex, opts)
  return {
    baseExDollars: quoteAmount(baseCents), discountDollars: quoteAmount(baseCents - netCents),
    netExDollars: quoteAmount(netCents), gstDollars: quoteAmount(totalCents - netCents),
    totalDollars: quoteAmount(totalCents), gstApplies: opts.gstRegistered === true, discountPct,
  }
}
