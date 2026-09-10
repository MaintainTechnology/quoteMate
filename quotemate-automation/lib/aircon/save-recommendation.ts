// Air-conditioning — persist a generated recommendation (migration 144).
// Shared by /api/aircon/recommend and /api/aircon/plan so BOTH branches of
// the dashboard tool land on the Quotes tab (trade-jobs cards) and get a
// customer page at /q/aircon/[token]. Callers must fail closed when this
// returns null so an unpersisted in-memory price never becomes an artefact.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createHmac } from 'node:crypto'
import { generateShareToken } from '@/lib/stripe/checkout'
import type { AcPricedRecommendation } from './types'

export type SavedAirconRecommendation = {
  id: string; public_token: string; recommendation: AcPricedRecommendation
  requestReceipt?: { fingerprint: string; responseContext: Record<string, unknown> }
} | null

function savedRecommendation(row: { id?: unknown; public_token?: unknown; recommendation?: unknown } | null): SavedAirconRecommendation {
  const value = row?.recommendation as AcPricedRecommendation | null | undefined
  if (typeof row?.id !== 'string' || typeof row.public_token !== 'string' || value?.pricing_status !== 'priced') return null
  const { _request_receipt: receipt, ...recommendation } = value as AcPricedRecommendation & { _request_receipt?: unknown }
  const metadata = receipt as { fingerprint?: unknown; responseContext?: unknown } | null | undefined
  const requestReceipt = typeof metadata?.fingerprint === 'string' && metadata.responseContext && typeof metadata.responseContext === 'object' && !Array.isArray(metadata.responseContext)
    ? { fingerprint: metadata.fingerprint, responseContext: metadata.responseContext as Record<string, unknown> } : undefined
  return { id: row.id, public_token: row.public_token, recommendation: recommendation as AcPricedRecommendation, ...(requestReceipt ? { requestReceipt } : {}) }
}

export class AirconRequestConflict extends Error {}

/** Ordered JSON over validated input, including plan bytes, binds one request
 * identity to one complete response. It never hashes tenant pricing changes.
 */
export function airconRequestFingerprint(input: unknown): string {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`
    return JSON.stringify(value) ?? 'null'
  }
  return createHmac('sha256', 'aircon-input-v1').update(stable(input)).digest('hex')
}

export async function readAirconRequestReplay(db: SupabaseClient, args: {
  tenantId: string | null; requestId?: string; secret?: string; fingerprint: string
}): Promise<NonNullable<SavedAirconRecommendation> | null> {
  if (!args.tenantId || !args.requestId) return null
  if (!args.secret) throw new Error('Aircon request identity secret unavailable')
  const token = airconIdempotencyToken({ tenantId: args.tenantId, requestId: args.requestId, secret: args.secret })
  const { data, error } = await db.from('aircon_recommendations').select('id,public_token,recommendation')
    .eq('tenant_id', args.tenantId).eq('public_token', token).maybeSingle()
  if (error) throw new Error('Saved aircon request could not be read')
  if (!data) return null
  const saved = savedRecommendation(data)
  if (!saved?.requestReceipt || saved.requestReceipt.fingerprint !== args.fingerprint) throw new AirconRequestConflict('Request identity already belongs to a different or legacy saved result')
  return saved
}

export function airconReplayResponse(saved: NonNullable<SavedAirconRecommendation>) {
  return { ...saved.requestReceipt?.responseContext, recommendation: saved.recommendation,
    saved: { id: saved.id, public_token: saved.public_token }, replayed: true }
}

export function airconIdempotencyToken(args: {
  tenantId: string
  requestId: string
  secret: string
}): string {
  return createHmac('sha256', args.secret)
    .update(`aircon:${args.tenantId}:${args.requestId}`)
    .digest('hex')
    .slice(0, 32)
}

/** created_by is a uuid → auth.users FK, so it must hold the SUPABASE auth id:
 *  tenant.owner_user_id for a Clerk caller, the caller's own id for a Supabase
 *  caller. Never a Clerk `user_…` string (which isn't a valid uuid) — the same
 *  trap app/api/roofing/save/route.ts documents. */
export function supabaseUserIdFor(
  identity: { provider: string; userId: string },
  tenant: { owner_user_id?: string | null } | null,
): string | null {
  return tenant?.owner_user_id ?? (identity.provider === 'supabase' ? identity.userId : null)
}

export async function saveAirconRecommendation(
  supabase: SupabaseClient,
  args: {
    tenantId: string | null
    createdBy: string | null
    address: { address: string; postcode: string; state: string }
    recommendation: AcPricedRecommendation
    requestId?: string
    idempotencySecret?: string
    requestFingerprint?: string
    responseContext?: Record<string, unknown>
  },
): Promise<SavedAirconRecommendation> {
  // Tenant-less callers (no tenants row yet) still get their in-memory
  // recommendation — nothing to anchor a saved job to.
  if (!args.tenantId) return null
  if (args.requestId && !args.idempotencySecret) return null
  const publicToken =
    args.requestId && args.idempotencySecret
      ? airconIdempotencyToken({
          tenantId: args.tenantId,
          requestId: args.requestId,
          secret: args.idempotencySecret,
        })
      : generateShareToken()
  if (args.requestId) {
    const { data: existing, error: lookupError } = await supabase
      .from('aircon_recommendations')
      .select('id, public_token, recommendation')
      .eq('tenant_id', args.tenantId)
      .eq('public_token', publicToken)
      .maybeSingle()
    if (lookupError) return null
    if (existing) {
      const saved = savedRecommendation(existing)
      if (args.requestFingerprint && saved?.requestReceipt?.fingerprint !== args.requestFingerprint) throw new AirconRequestConflict('Request content changed')
      return saved
    }
  }
  const { data: row, error } = await supabase
    .from('aircon_recommendations')
    .insert({
      tenant_id: args.tenantId,
      created_by: args.createdBy,
      address: args.address.address,
      postcode: args.address.postcode,
      state: args.address.state,
      recommendation: args.requestId && args.requestFingerprint && args.responseContext
        ? { ...args.recommendation, _request_receipt: { fingerprint: args.requestFingerprint, responseContext: args.responseContext } }
        : args.recommendation,
      routing: args.recommendation.routing.decision,
      public_token: publicToken,
    })
    .select('id')
    .single()
  if (error || !row) {
    if (args.requestId) {
      // A concurrent retry can win the unique public-token insert after the
      // pre-read. Resolve that winner instead of fabricating a second job.
      const { data: existing, error: lookupError } = await supabase
        .from('aircon_recommendations')
        .select('id, public_token, recommendation')
        .eq('tenant_id', args.tenantId)
        .eq('public_token', publicToken)
        .maybeSingle()
      if (!lookupError && existing) {
        const saved = savedRecommendation(existing)
        if (args.requestFingerprint && saved?.requestReceipt?.fingerprint !== args.requestFingerprint) throw new AirconRequestConflict('Request content changed')
        return saved
      }
    }
    console.warn('[aircon] recommendation save skipped — insert failed', error?.message)
    return null
  }
  return { id: row.id as string, public_token: publicToken, recommendation: args.recommendation,
    ...(args.requestId && args.requestFingerprint && args.responseContext ? { requestReceipt: { fingerprint: args.requestFingerprint, responseContext: args.responseContext } } : {}) }
}
