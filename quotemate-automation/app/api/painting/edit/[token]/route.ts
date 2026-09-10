// ════════════════════════════════════════════════════════════════════
// POST /api/painting/edit/[token] — the tradie "edit the full quote" step.
//
// Token = painting_measurements.estimate_token (the tradie review link's
// capability, same trust model as /p/[token] + /api/painting/release: holding
// the unguessable estimate_token authorises the edit; the customer only ever
// has public_token). Lets the painter override each tier's customer-visible
// label, scope text, and inc-GST headline — before sending (the held-draft
// review) or AFTER release (the on-site revision: confirm measurements at the
// property, adjust the numbers, then resend the updated quote).
//
// Edits are applied by the pure lib/painting/edit.ts (ex-GST + band derive
// from the headline), persisted back onto painting_measurements.estimate
// (jsonb) + the denormalised better_inc_gst column. Both the customer page
// (/q/paint/[public_token]) and the customer SMS read estimate.price.tiers
// straight from the jsonb, so the edit flows through immediately; a price
// change expires (and drops) any legacy per-tier Stripe deposit session left
// on the row — nothing re-mints them, since the customer's only payment is
// the flat $99 site visit (spec painting-site-visit-first).
//
// Refuses to edit an inspection-routed job (no priced tiers).
// Next 16: params is a Promise.
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { applyTierEdits, type PaintingTierEdit } from '@/lib/painting/edit'
import type { PaintingEstimate } from '@/lib/painting/types'
import { PAINT_INSPECTION_TIER } from '@/lib/painting/pay-redirect'
import { expireCheckoutSession } from '@/lib/stripe/checkout'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { paintingEditVersion } from '@/lib/painting/edit-version'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60 // a priced edit expires stale Stripe sessions

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const TierEditSchema = z.object({
  tier: z.enum(['good', 'better', 'best']),
  label: z.string().trim().max(120).optional(),
  scope: z.string().trim().max(600).optional(),
  inc_gst: z.coerce.number().positive().max(1_000_000).optional(),
})

const BodySchema = z.object({
  tiers: z.array(TierEditSchema).min(1).max(3),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  approveChanges: z.boolean().optional(),
})

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const owner = await resolveTenantRequest(supabase,req,'id')
  if (!owner?.tenant?.id) return Response.json({ok:false,error:'Sign in as the owning tradie before editing.'},{status:401})
  const tenantId=owner.tenant.id as string
  const { token } = await ctx.params
  if (!token || token.length < 8) {
    return Response.json({ ok: false, error: 'invalid_token' }, { status: 400 })
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'validation_failed', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const { data: row, error: readError } = await supabase
    .from('painting_measurements')
    .select('id, tenant_id, estimate, released_at, paid_at, routing, public_token, address, stripe_links')
    .eq('estimate_token', token)
    .eq('tenant_id',tenantId)
    .maybeSingle()
  if (readError) return Response.json({ok:false,error:'Quote temporarily unavailable.'},{status:503})
  if (!row || row.tenant_id !== tenantId) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }
  if (!row.estimate) {
    return Response.json({ ok: false, error: 'no_estimate' }, { status: 409 })
  }
  if (parsed.data.expectedVersion !== paintingEditVersion(row.estimate)) return Response.json({ok:false,error:'This quote changed. Refresh and review it again.'},{status:409})
  if (row.released_at && parsed.data.approveChanges !== true) return Response.json({ok:false,error:'Approve the revised prices and scope before updating the customer quote.'},{status:409})
  // Transacted prices are immutable: once the customer has paid, the tiers are
  // the record of what they accepted. (The old released_at gate used to block
  // this incidentally; post-release editing made an explicit paid guard
  // necessary.)
  if ((row.paid_at as string | null) != null) {
    return Response.json(
      {
        ok: false,
        error: 'cannot_edit_paid_quote',
        hint: 'The customer has already paid against these prices.',
      },
      { status: 409 },
    )
  }
  // An inspection-routed job has no priced tiers to edit.
  if ((row.routing as string | null) === 'inspection_required') {
    return Response.json(
      {
        ok: false,
        error: 'cannot_edit_inspection_quote',
        hint: 'This job is routed to an on-site measure — there are no priced tiers to edit.',
      },
      { status: 409 },
    )
  }
  const { estimate: nextEstimate, betterIncGst, changed, priceChanged } = applyTierEdits(
    row.estimate as PaintingEstimate,
    parsed.data.tiers as PaintingTierEdit[],
  )

  if (!changed) {
    return Response.json({ ok: true, changed: false, public_token: row.public_token })
  }

  const updateBody: Record<string, unknown> = {
    estimate: nextEstimate,
    better_inc_gst: betterIncGst,
  }
  const stale: string[] = []

  // A price change invalidates any per-tier Stripe deposit session left on the
  // row (their unit_amount was baked from the OLD inc-GST), and on a released
  // quote the customer may still HOLD those links. Nothing re-mints them —
  // since spec painting-site-visit-first the customer's only payment is the
  // flat $99 site visit — so we DROP them and EXPIRE them, and an open
  // Checkout tab from the deposit era can never complete at a price the tradie
  // just changed. stripe_links.inspection is preserved untouched: the $99 fee
  // does not move with the tier prices.
  if (priceChanged) {
    const oldLinks = (row.stripe_links ?? {}) as Record<string, string | undefined>
    const kept: Record<string, string> = {}
    for (const [tier, url] of Object.entries(oldLinks)) {
      if (!url) continue
      if (tier === PAINT_INSPECTION_TIER) kept[tier] = url
      else stale.push(url)
    }
    updateBody.stripe_links = kept
    // Best-effort (expireCheckoutSession tolerates already-expired/paid).
  }

  let update = supabase
    .from('painting_measurements')
    .update(updateBody)
    .eq('id', row.id)
    .eq('tenant_id',tenantId).is('paid_at',null).eq('estimate',JSON.stringify(row.estimate))
  update = row.released_at ? update.eq('released_at',row.released_at) : update.is('released_at',null)
  const { data: saved,error: updErr } = await update.select('id').maybeSingle()
  if (updErr) {
    return Response.json({ ok: false, error: 'update_failed' }, { status: 500 })
  }
  if (!saved) return Response.json({ok:false,error:'The quote changed or was paid while you were editing. Refresh before trying again.'},{status:409})
  await Promise.allSettled(stale.map((url) => expireCheckoutSession(url)))

  return Response.json({
    ok: true,
    changed: true,
    public_token: row.public_token,
    tiers: nextEstimate.price.tiers,
  })
}
