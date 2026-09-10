'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PaintSaveScope } from './browser-save-receipt'
import { browserPaintCorrectionStore, readBrowserPaintCorrectionStatus, type PaintCorrectionCopy } from './browser-correction-receipt'
import { serialisePaintCorrection, type PaintCorrectionInput, type PaintCorrectionOutcome } from './correction-contract'

type Verify = () => Promise<{ init: RequestInit }>
const endpoint = (copy: PaintCorrectionCopy) => `/api/tenant/commercial-painting/run/${copy.runId}/corrections`
/** Retain the exact encrypted command before POST. Opening performs GET only;
 * retries are explicit and always reuse the same ID, baseline and input. */
export function usePaintCorrections(scope: PaintSaveScope, verify: Verify) {
  const [copy, setCopy] = useState<PaintCorrectionCopy | null>(null)
  const [outcome, setOutcome] = useState<PaintCorrectionOutcome | null>(null)
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const epoch = useRef(0), mutex = useRef(false)
  const current = useCallback((generation: number) => epoch.current === generation, [])
  const check = useCallback(async (retained: PaintCorrectionCopy) => {
    if (mutex.current) return
    const generation = epoch.current; mutex.current = true; setBusy(true); setError(null)
    try {
      const { init } = await verify(); if (!current(generation)) return
      const response = await fetch(`${endpoint(retained)}?operationId=${retained.input.operationId}`, { ...init, signal: AbortSignal.timeout(15000) })
      const body = await response.json(); if (!current(generation)) return
      if (!response.ok) throw new Error()
      const result = readBrowserPaintCorrectionStatus(body, retained)
      await verify(); if (!current(generation)) return
      if (result.status === 'applied') setOutcome(result)
      else setError('No correction result is visible yet. Your exact working copy is retained; check again or explicitly retry the same correction.')
    } catch { if (current(generation)) setError('The correction outcome could not be verified. Your working copy is retained.') }
    finally { if (current(generation)) { mutex.current = false; setBusy(false) } }
  }, [current, verify])
  const reloadStorage = useCallback(async () => {
    const generation = epoch.current
    try {
      const retained = await browserPaintCorrectionStore(scope).read(); if (!current(generation)) return
      setCopy(retained); setReady(true); setError(null)
      if (retained && !retained.rejected) void check(retained)
    } catch { if (current(generation)) setError('Encrypted correction recovery is unavailable. Check storage before editing or saving.') }
  }, [scope, check, current])
  useEffect(() => {
    epoch.current += 1; mutex.current = false
    const generation = epoch.current
    void Promise.resolve().then(() => { if (current(generation)) return reloadStorage() })
    return () => { epoch.current += 1 }
  }, [reloadStorage, current])
  const submit = async (retained: PaintCorrectionCopy, generation: number) => {
    const requestBody = serialisePaintCorrection(retained.input)
    const { init } = await verify(); if (!current(generation)) return null
    const store = browserPaintCorrectionStore(scope)
    const attempted = await store.markAttempt(retained); if (!current(generation)) return null
    setCopy(attempted)
    const response = await fetch(endpoint(attempted), { ...init, method: 'POST', headers: { ...init.headers, 'content-type': 'application/json' },
      body: requestBody, signal: AbortSignal.timeout(20000) })
    const body = await response.json(); if (!current(generation)) return null
    await verify(); if (!current(generation)) return null
    if (!response.ok) {
      const initialRejection = (response.status === 400 && ['invalid_json', 'invalid_request', 'invalid_correction'].includes(body.error)) ||
        (response.status === 409 && ['correction_conflict', 'released_quote_immutable'].includes(body.error)) ||
        (response.status === 404 && body.error === 'not_found')
      if (initialRejection) {
        const rejected = await store.markInitialRejection(attempted)
        if (current(generation)) { setCopy(rejected); setError(rejected.rejected
          ? 'The correction was rejected before any changes were saved. Your working copy is retained. Review the latest saved data before editing again.'
          : 'A prior attempt may still complete. Check the retained correction before continuing.') }
      } else setError('Saving corrections could not be confirmed. Your exact working copy is retained.')
      return null
    }
    const result = readBrowserPaintCorrectionStatus(body, attempted)
    if (result.status !== 'applied') throw new Error()
    setOutcome(result)
    return result
  }
  const save = async (runId: string, input: PaintCorrectionInput, labourRatePerHr: number | null) => {
    if (!ready || copy || mutex.current) return null
    serialisePaintCorrection(input) // No receipt or POST for an oversized command.
    const generation = epoch.current; mutex.current = true; setBusy(true); setError(null)
    try {
      await verify(); if (!current(generation)) return null
      const retained = await browserPaintCorrectionStore(scope).begin(runId, input, labourRatePerHr)
      if (!current(generation)) return null
      setCopy(retained)
      const result = await submit(retained, generation)
      return result ? { result, copy: retained } : null
    } catch {
      if (current(generation)) setError('Saving corrections could not be confirmed. Check encrypted recovery before trying again.')
      return null
    } finally { if (current(generation)) { mutex.current = false; setBusy(false) } }
  }
  const retry = async () => {
    if (!copy || copy.rejected || outcome || mutex.current) return
    const generation = epoch.current; mutex.current = true; setBusy(true); setError(null)
    try { await submit(copy, generation) }
    catch { if (current(generation)) setError('Saving corrections could not be confirmed. Your exact working copy is retained.') }
    finally { if (current(generation)) { mutex.current = false; setBusy(false) } }
  }
  const acknowledge = async (retained: PaintCorrectionCopy, verified?: PaintCorrectionOutcome) => {
    const result = verified ?? outcome
    if (!retained.rejected && (!result || result.operationId !== retained.input.operationId || result.requestHash !== retained.requestHash)) return false
    const generation = epoch.current
    try {
      await verify(); if (!current(generation)) return false
      await browserPaintCorrectionStore(scope).complete(retained); if (!current(generation)) return false
      setCopy(null); setOutcome(null); setError(null); return true
    } catch { if (current(generation)) setError('The result was verified, but correction recovery could not be cleared. Your copy is retained.'); return false }
  }
  return { copy, outcome, ready, busy, error, save, retry, check, acknowledge, reloadStorage,
    blocked: !ready || !!copy || busy || !!error }
}
