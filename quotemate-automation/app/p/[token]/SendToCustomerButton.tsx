'use client'

// Authenticated approval and delivery recovery for the saved painting quote.
import { useEffect, useRef, useState } from 'react'
import { getAuthToken } from '@/lib/auth/client-token'

export function SendToCustomerButton({
  estimateToken,
  sent,
}: {
  estimateToken: string
  /** painting_measurements.quote_sent_at present — a carrier ACCEPTED the
   *  quote message. Never released_at: a dashboard save stamps that and texts
   *  nobody, which is how this button used to show "Sent" for a quote the
   *  customer never received. */
  sent: boolean
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>(sent ? 'sent' : 'idle')
  const [err, setErr] = useState<string | null>(null)
  // Resend of an already-released quote (spec tradie-onsite-quote-editing R5)
  // — after an on-site edit the tradie re-texts the updated quote. POSTs
  // { resend: true }; the server sends without restamping released_at.
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resendRequestId = useRef<string | null>(null)
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current) }, [])

  const send = async () => {
    setState('sending')
    setErr(null)
    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in to review and send this quote.')
      const res = await fetch(`/api/painting/release/${estimateToken}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      const j = await res.json()
      if (typeof j.reviewUrl === 'string' && j.reviewUrl.startsWith('/dashboard/quote-review?')) { window.location.assign(j.reviewUrl); return }
      // "Sent" requires proof the SMS went out — ok alone is not proof.
      if (j.ok && j.sent === true) setState('sent')
      else {
        setState('error')
        setErr(
          j.error
            ? String(j.error)
            : 'Delivery is not confirmed. Check SMS delivery recovery before retrying.',
        )
      }
    } catch (e) {
      setState('error')
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const resend = async () => {
    // A stale reset timer from a previous resend must not flip the state back
    // to idle while this request is in flight.
    if (resetTimer.current) clearTimeout(resetTimer.current)
    setResendState('sending')
    setErr(null)
    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in to resend this quote.')
      resendRequestId.current ??= crypto.randomUUID()
      const res = await fetch(`/api/painting/release/${estimateToken}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ resend: true, requestId: resendRequestId.current }),
      })
      const j = await res.json()
      if (j.ok && j.sent === true) {
        setResendState('done')
        resendRequestId.current = null
        resetTimer.current = setTimeout(() => setResendState('idle'), 4000)
      } else {
        setResendState('error')
        setErr(j.error ? String(j.error) : 'Delivery is not confirmed. Check SMS delivery recovery before retrying.')
      }
    } catch (e) {
      setResendState('error')
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  if (state === 'sent') {
    return (
      <span className="inline-flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 border border-accent bg-accent/10 px-6 py-3 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-accent">
          ✓ Sent to customer
        </span>
        <button
          type="button"
          onClick={resend}
          disabled={resendState === 'sending'}
          className="inline-flex items-center gap-2 border border-ink-line px-5 py-3 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-text-pri transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {resendState === 'sending' ? 'Resending…' : 'Resend updated quote'}
        </button>
        {resendState === 'done' && (
          <span className="font-mono text-sm uppercase tracking-[0.14em] text-accent">✓ Resent</span>
        )}
        {resendState === 'error' && err && <span className="text-sm text-warning">{err}</span>}
      </span>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <button
        type="button"
        // A retry after a failed send asks for a resend, so it still delivers
        // if that attempt left the row released.
        onClick={() => send()}
        disabled={state === 'sending'}
        className="inline-flex items-center gap-2 bg-accent px-6 py-3 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-white transition-colors hover:bg-accent-press disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state === 'sending' ? 'Sending…' : (<>Review and send <span aria-hidden="true">&rarr;</span></>)}
      </button>
      {err && <span className="text-sm text-warning">{err}</span>}
    </span>
  )
}
