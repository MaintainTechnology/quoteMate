// Admin authorisation gate for the bulk loader (spec §9 rule 4 — a real
// server-side admin check on every admin route + API; never a client flag).
//
// admin_users (migration 050) is the allow-list: a Supabase auth user_id is
// an admin iff it has a row there. This is checked with the service-role
// client inside the route, before any loader work runs.

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * True iff `userId` is in the admin_users allow-list.
 *
 * Fails CLOSED: a null/blank user, a DB error, or any thrown exception all
 * return false — an admin route must never run for a non-admin because the
 * check itself errored.
 */
export async function isAdminUser(
  supabase: SupabaseClient,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false
  try {
    const { data, error } = await supabase
      .from('admin_users')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) return false
    return data != null
  } catch {
    return false
  }
}
