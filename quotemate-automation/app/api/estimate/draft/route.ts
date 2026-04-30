import { createClient } from '@supabase/supabase-js'
import { runEstimation } from '@/lib/estimate/run'

export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: Request) {
  try {
  const { intakeId } = await req.json()

  const { data: intake } = await supabase.from('intakes').select('*').eq('id', intakeId).single()
  const { data: pricingBook } = await supabase.from('pricing_book').select('*').single()

  const draft = await runEstimation(intake, pricingBook)

  // Default selected tier for the customer portal is "better".
  // Falls through to "good" if better is missing (e.g. fault_finding has no best).
  const defaultTier = draft.better ?? draft.good
  const selectedSubtotal = defaultTier?.subtotal_ex_gst ?? 0
  const gst = pricingBook.gst_registered ? +(selectedSubtotal * 0.10).toFixed(2) : 0
  const total = +(selectedSubtotal + gst).toFixed(2)

  const { data: quote } = await supabase.from('quotes').insert({
    intake_id: intakeId,
    status: 'draft',
    scope_of_works:      draft.scope_of_works,
    assumptions:         draft.assumptions      ?? [],
    risk_flags:          draft.risk_flags       ?? [],
    good:                draft.good             ?? null,
    better:              draft.better           ?? null,
    best:                draft.best             ?? null,
    optional_upsells:    draft.optional_upsells ?? [],
    estimated_timeframe: draft.estimated_timeframe,
    needs_inspection:    draft.needs_inspection,
    inspection_reason:   draft.inspection_reason,
    gst_note:            draft.gst_note,
    selected_tier:       'better',
    subtotal_ex_gst:     selectedSubtotal,
    gst,
    total_inc_gst:       total,
  }).select().single()

  // Line items live inside the good/better/best JSONB columns —
  // no separate quote_line_items insert is needed at draft time.
  // (We materialise quote_line_items only after the customer accepts a tier.)

  return Response.json({ ok: true, quoteId: quote!.id })
  } catch (err: any) {
    console.error('[/api/estimate/draft] error:', err)
    return Response.json({
      ok: false,
      error: err?.message ?? String(err),
      cause: err?.cause?.message,
      stack: err?.stack?.split('\n').slice(0, 6).join('\n'),
    }, { status: 500 })
  }
}
