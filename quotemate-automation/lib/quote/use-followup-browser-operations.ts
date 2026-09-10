'use client'

import { useEffect, useMemo, useRef } from 'react'
import { getAuthToken } from '@/lib/auth/client-token'
import { createBrowserFollowupOperations } from './followup-browser-operation'

export function useFollowupBrowserOperations(scopeKey: string) {
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [scopeKey])
  return useMemo(() => ({
    recover: (...args: Parameters<ReturnType<typeof createBrowserFollowupOperations>['recover']>) =>
      createBrowserFollowupOperations({ getToken: getAuthToken, signal: lifetime.current.signal }).recover(...args),
    submit: (...args: Parameters<ReturnType<typeof createBrowserFollowupOperations>['submit']>) =>
      createBrowserFollowupOperations({ getToken: getAuthToken, signal: lifetime.current.signal }).submit(...args),
  }), [])
}
