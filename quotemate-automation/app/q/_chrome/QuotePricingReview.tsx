import { INSPECTION_FEE_AUD } from '@/lib/quote/money'

/** A priced view never substitutes today's tax when historical evidence is
 * missing. Customer-authored narrative remains readable during review. */
export function QuotePricingReview({ scope, inspectionUrl }: { scope?: string | null; inspectionUrl?: string }) {
  return <main style={{ maxWidth: 620, margin: '80px auto', padding: 24 }}>
    <h1>Quote pricing needs review</h1>
    <p>The saved pricing basis could not be verified. Your tradie needs to review this quote before a priced report can be shown.</p>
    {scope ? <section><h2>Scope of works</h2><p style={{ whiteSpace: 'pre-wrap' }}>{scope}</p></section> : null}
    {inspectionUrl ? <p><a href={inspectionUrl}>Book the ${INSPECTION_FEE_AUD} refundable site visit</a></p> : null}
  </main>
}
