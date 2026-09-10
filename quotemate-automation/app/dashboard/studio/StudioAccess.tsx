'use client'
import { useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { getBrowserSupabase } from '@/lib/supabase/client'
import type { StudioToken } from '@/lib/studio/client-render'

// Account changes remount the editor, discarding private copy and revoking its
// blob URLs. A Clerk account never falls through to a different legacy session.
export function StudioAccess({ children }: { children: (identity: string, token: StudioToken) => React.ReactNode }) {
  const { isLoaded, userId, sessionId, getToken } = useAuth()
  const [legacyId, setLegacyId] = useState<string | null>(null)
  const [legacyLoaded, setLegacyLoaded] = useState(false)
  useEffect(() => {
    if (!isLoaded || userId) return
    let active = true
    let changed = false
    const supabase = getBrowserSupabase()
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      changed = true
      if (active) { setLegacyId(session?.user.id ?? null); setLegacyLoaded(true) }
    })
    void supabase.auth.getSession().then(({ data: current }) => {
      if (active && !changed) { setLegacyId(current.session?.user.id ?? null); setLegacyLoaded(true) }
    }).catch(() => { if (active) { setLegacyId(null); setLegacyLoaded(true) } })
    return () => { active = false; data.subscription.unsubscribe() }
  }, [isLoaded, userId])
  const token = useCallback(async () => {
    if (userId) return getToken()
    if (!legacyId) return null
    const { data } = await getBrowserSupabase().auth.getSession()
    return data.session?.user.id === legacyId ? data.session.access_token : null
  }, [getToken, userId, legacyId])
  if (!isLoaded || (!userId && !legacyLoaded)) return <p className="p-6" role="status">Loading your business account…</p>
  if (!userId && !legacyId) return <div className="p-6"><p>Sign in to your business account to use Brand Studio.</p><Link href="/sign-in">Sign in</Link></div>
  return children(userId ? `clerk:${userId}:${sessionId}` : `legacy:${legacyId}`, token)
}
