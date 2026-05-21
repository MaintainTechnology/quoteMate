// Bearer-token → admin-user resolution for the /api/admin/loader/* routes.
//
// Every admin route calls this first (spec §9 rule 4 — a real server-side
// admin check on every admin route + API). It mirrors the userFromBearer
// pattern the rest of the app uses, then adds the admin_users gate.

import type { SupabaseClient } from '@supabase/supabase-js'
import { isAdminUser } from './auth'

/**
 * Resolve the request's `Authorization: Bearer <token>` to an ADMIN auth
 * user id. Returns null for a missing/invalid token OR a non-admin user —
 * the route turns either into a 403, so a non-admin learns nothing.
 */
export async function resolveAdminUserId(
  supabase: SupabaseClient,
  req: Request,
): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  const admin = await isAdminUser(supabase, data.user.id)
  return admin ? data.user.id : null
}
