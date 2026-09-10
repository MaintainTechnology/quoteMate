'use client'

import { useCallback, useEffect, useState } from 'react'
import { getAuthToken } from '@/lib/auth/client-token'

type Message = { id: string; status: string; body: string; to_number: string; audience: string;
  provider_error: string | null; requires_attention: boolean; created_at: string }
export default function SmsDeliveryPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [notice, setNotice] = useState('Loading delivery status…')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const token = await getAuthToken()
    if (!token) { setNotice('Sign in to view your message delivery.'); return }
    const response = await fetch('/api/tenant/sms-delivery', { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error('Delivery status is temporarily unavailable. Please try again.')
    const data = await response.json()
    setMessages(data.messages)
    setNotice(data.messages.length ? '' : 'No messages have been queued yet.')
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => { void load().catch(error => setNotice(error.message)) }, 0)
    return () => clearTimeout(timer)
  }, [load])
  async function retry(id: string) {
    setBusy(true)
    try {
      const token = await getAuthToken()
      const response = await fetch('/api/tenant/sms-delivery', { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Retry could not be scheduled.')
      await load()
      setNotice('The message is queued for another delivery attempt.')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Retry could not be scheduled.') }
    finally { setBusy(false) }
  }
  return <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 text-text-pri">
    <h1 className="text-2xl font-semibold">SMS delivery</h1>
    <p className="text-text-dim">Accepted messages are with the provider. Delivered messages have a delivery receipt. An unknown result needs investigation before sending again.</p>
    <button type="button" disabled={busy} onClick={() => void load().catch(error => setNotice(error.message))}
      className="rounded border border-ink-line px-4 py-2">Refresh</button>
    <p role="status">{notice}</p>
    <ul className="space-y-4">{messages.map(message => <li key={message.id} className="space-y-2 rounded border border-ink-line p-4">
      <div className="flex flex-wrap justify-between gap-2"><strong>{message.status}</strong>
        <time>{new Date(message.created_at).toLocaleString('en-AU')}</time></div>
      <p>{message.audience === 'tradie' ? 'Tradie' : 'Customer'} · {message.to_number}</p>
      <p className="whitespace-pre-wrap break-words">{message.body}</p>
      {message.requires_attention && <p>Needs attention{message.provider_error ? ` · provider code ${message.provider_error}` : ''}</p>}
      {['failed','undelivered'].includes(message.status) && message.provider_error !== '21610' &&
        <button type="button" disabled={busy} onClick={() => void retry(message.id)} className="rounded border border-ink-line px-4 py-2">Retry this message</button>}
    </li>)}</ul>
  </main>
}
