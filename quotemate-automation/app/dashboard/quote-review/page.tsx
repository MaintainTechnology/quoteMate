'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { getAuthToken } from '@/lib/auth/client-token'
import type { SavedQuoteReview } from '@/lib/sms/quote-review'

type Review = Omit<SavedQuoteReview, 'sourceSnapshot'>
const aud = (value: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value)

export default function QuoteReviewPage() {
  const [review,setReview] = useState<Review | null>(null)
  const [phone,setPhone] = useState('')
  const [confirmed,setConfirmed] = useState(false)
  const [busy,setBusy] = useState(false)
  const [notice,setNotice] = useState('Loading the saved result…')
  const [accepted,setAccepted] = useState(false)
  const load = useCallback(async (): Promise<Review> => {
    const token = await getAuthToken()
    if (!token) throw new Error('Sign in to review this customer request.')
    const query = new URLSearchParams(window.location.search)
    const res = await fetch(`/api/sms/quote-release?family=${encodeURIComponent(query.get('family') ?? '')}&id=${encodeURIComponent(query.get('id') ?? '')}`,
      { headers: { Authorization: `Bearer ${token}` } })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? 'The saved result is unavailable.')
    return body.review
  },[])
  const showReview = useCallback((saved: Review) => {
    setConfirmed(false);setAccepted(false)
    setReview(saved);setPhone(saved.customerPhone ?? '');setNotice('')
  }, [])
  useEffect(() => {
    let active = true
    void load().then((saved) => { if (active) showReview(saved) }).catch((error) => { if (active) setNotice(error.message) })
    return () => { active = false }
  },[load,showReview])
  async function approve() {
    if (!review || !review.canApprove || !confirmed || !phone.trim()) return
    setBusy(true)
    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again before approving.')
      const res = await fetch('/api/sms/quote-release', { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type':'application/json' },
        body: JSON.stringify({ family: review.family, id: review.id, customerPhone: phone, approve: true, reviewVersion: review.version }) })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Approval could not be saved.')
      setAccepted(true);setConfirmed(false)
      setNotice(body.accepted ? 'Approved. The SMS provider accepted the quote message. Check delivery for the final result.'
        : 'Approved. The message is saved for delivery recovery; it has not been confirmed as received.')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Approval could not be saved.') }
    finally { setBusy(false) }
  }
  return <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 text-text-pri">
    <Link className="underline" href="/dashboard/sms-recovery">Back to enquiries</Link>
    <h1 className="text-2xl font-semibold">Review customer quote</h1>
    <p>Check the saved scope, prices and customer before approving. Approval sends the saved result without calculating another quote.</p>
    <p role="status" aria-live="polite">{notice}</p>
    <button disabled={busy} onClick={() => void load().then(showReview).catch((error) => setNotice(error.message))}
      className="rounded border border-ink-line px-4 py-2">Refresh saved result</button>
    {review && <>
      <section className="space-y-3 rounded border border-ink-line p-5">
        <h2 className="text-xl font-semibold">{review.address}</h2>
        <p>{review.approved ? 'Previously approved' : 'Awaiting approval'} · {review.createdAt ? new Date(review.createdAt).toLocaleDateString('en-AU') : 'Saved request'}</p>
        <label className="block space-y-2"><span>Customer mobile</span>
          <input type="tel" autoComplete="tel" value={phone} readOnly={Boolean(review.customerPhone)}
            onChange={(event) => setPhone(event.target.value)} className="block w-full rounded border border-ink-line bg-ink-card p-3" />
        </label>
        {!review.customerPhone && <p>Enter the customer who owns this request. An existing customer binding cannot be changed here.</p>}
      </section>
      {review.amounts.length > 0 && <section className="space-y-3">
        <h2 className="text-xl font-semibold">Saved customer prices</h2>
        <table className="w-full text-left"><thead><tr><th className="py-2">Option</th><th>Amount</th></tr></thead>
          <tbody>{review.amounts.map((amount,index) => <tr key={index} className="border-t border-ink-line">
            <td className="py-3">{amount.label}</td><td>{amount.incGst == null ? 'Not priced' : aud(amount.incGst)}{amount.highIncGst != null ? ` – ${aud(amount.highIncGst)}` : ''}</td>
          </tr>)}</tbody></table>
      </section>}
      <section className="space-y-3"><h2 className="text-xl font-semibold">Scope of work</h2>
        {review.scope.length ? <ul className="list-disc space-y-2 pl-5">{review.scope.map((line,index) => <li key={index}>{line}</li>)}</ul>
          : <p>No additional scope notes were saved. Check the originating estimating tool if details need changing.</p>}
        {review.quantities.length > 0 && <table className="w-full text-left"><thead><tr><th>Item</th><th>Quantity</th></tr></thead><tbody>
          {review.quantities.map((line,index) => <tr key={index}><td className="py-2">{line.label}</td><td>{line.quantity}</td></tr>)}
        </tbody></table>}
      </section>
      {review.warnings.length > 0 && <section className="space-y-2 rounded border border-ink-line p-5">
        <h2 className="font-semibold">Review notes</h2><ul className="list-disc space-y-2 pl-5">{review.warnings.map((line,index) => <li key={index}>{line}</li>)}</ul>
      </section>}
      <label className="flex items-start gap-3"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy || accepted} />
        <span>I have checked this saved result and the customer mobile, and approve sharing it with this customer.</span></label>
      <button disabled={busy || accepted || !review.canApprove || !confirmed || !phone.trim()} onClick={() => void approve()}
        className="rounded bg-accent px-5 py-3 font-semibold text-accent-ink hover:bg-accent-press disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Saving approval…' : 'Approve and send saved result'}</button>
      <p><Link className="underline" href="/dashboard/sms-delivery">Check SMS delivery and recovery</Link></p>
    </>}
  </main>
}
