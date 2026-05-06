'use client'

import { useState } from 'react'

type Status = 'idle' | 'submitting' | 'done' | 'error'

function formatSlot(iso: string): { day: string; time: string } {
  const d = new Date(iso)
  const day = d.toLocaleString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Australia/Sydney',
  })
  const time = d.toLocaleString('en-AU', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Australia/Sydney',
  })
  return { day, time }
}

export function SlotPicker({ token, slots }: { token: string; slots: string[] }) {
  const [picked, setPicked] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Sort by time ascending; future slots only.
  const now = Date.now()
  const visible = [...slots]
    .filter((s) => {
      const t = Date.parse(s)
      return Number.isFinite(t) && t > now
    })
    .sort((a, b) => Date.parse(a) - Date.parse(b))

  async function onConfirm() {
    if (!picked) return
    setStatus('submitting')
    setErrorMessage(null)
    try {
      const res = await fetch(`/api/q/${token}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot: picked }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error ?? `Couldn't lock in slot (HTTP ${res.status}).`)
      }
      setStatus('done')
      // Reload so the server-rendered page re-renders into AlreadyScheduledState.
      setTimeout(() => window.location.reload(), 600)
    } catch (err: any) {
      setStatus('error')
      setErrorMessage(err?.message ?? 'Booking failed. Try another slot or reply to your SMS.')
    }
  }

  if (visible.length === 0) {
    return (
      <p className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
        No upcoming slots are open. Your tradie will SMS you to arrange a time.
      </p>
    )
  }

  return (
    <div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {visible.map((iso) => {
          const { day, time } = formatSlot(iso)
          const isPicked = picked === iso
          return (
            <li key={iso}>
              <button
                type="button"
                onClick={() => setPicked(iso)}
                disabled={status === 'submitting' || status === 'done'}
                className={`w-full rounded-lg border-2 p-4 text-left transition-colors ${
                  isPicked
                    ? 'border-zinc-900 bg-zinc-900 text-white'
                    : 'border-zinc-200 bg-white text-zinc-900 hover:border-zinc-400'
                } ${status === 'submitting' || status === 'done' ? 'opacity-60 cursor-not-allowed' : ''}`}
                aria-pressed={isPicked}
              >
                <div className={`text-xs font-semibold uppercase tracking-widest ${isPicked ? 'text-zinc-300' : 'text-zinc-500'}`}>
                  {day}
                </div>
                <div className="mt-1 text-lg font-bold">{time}</div>
              </button>
            </li>
          )
        })}
      </ul>

      <button
        type="button"
        onClick={onConfirm}
        disabled={!picked || status === 'submitting' || status === 'done'}
        className={`mt-6 w-full rounded-md px-4 py-3 text-center text-sm font-semibold text-white transition-colors ${
          !picked || status === 'submitting' || status === 'done'
            ? 'cursor-not-allowed bg-zinc-300'
            : 'bg-zinc-900 hover:bg-zinc-700'
        }`}
      >
        {status === 'submitting' ? 'Locking in…' : status === 'done' ? 'Locked in ✓' : 'Confirm this time'}
      </button>

      {errorMessage ? (
        <p className="mt-4 text-sm text-red-700">{errorMessage}</p>
      ) : null}
    </div>
  )
}
