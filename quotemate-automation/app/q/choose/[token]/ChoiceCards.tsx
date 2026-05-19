'use client'

// WP9 — the two product cards. Tapping one POSTs to
// /api/q/choose/[token] and shows confirmation. Idempotent server-side,
// so a double-tap or revisit is safe.

import { useState } from 'react'

type Opt = {
  catalogue_id: string
  name: string
  brand: string | null
  range_series: string | null
  price_ex_gst: number
  image_path: string | null
  description: string | null
  tier: 'good' | 'better'
}

export function ChoiceCards({
  token,
  options,
  initialStatus,
  initialChosenId,
}: {
  token: string
  options: Opt[]
  initialStatus: 'pending' | 'chosen'
  initialChosenId: string | null
}) {
  const [chosenId, setChosenId] = useState<string | null>(
    initialStatus === 'chosen' ? initialChosenId : null,
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function choose(id: string) {
    if (busy || chosenId) return
    setBusy(id)
    setError(null)
    try {
      const res = await fetch(`/api/q/choose/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogue_id: id }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        error?: string
        chosen_catalogue_id?: string | null
      }
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setChosenId(json.chosen_catalogue_id ?? id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // "I don't mind — go with the recommended one." Resolves server-side
  // to the recommended option so the customer is never forced to pick.
  async function chooseDefer() {
    if (busy || chosenId) return
    setBusy('__defer__')
    setError(null)
    try {
      const res = await fetch(`/api/q/choose/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defer: true }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        error?: string
        chosen_catalogue_id?: string | null
      }
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setChosenId(json.chosen_catalogue_id ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      {chosenId && (
        <div className="mb-6 bg-accent/10 border border-accent/40 px-4 py-3 text-sm text-text-pri">
          ✓ Choice recorded. We&apos;ve added{' '}
          <strong>{options.find((o) => o.catalogue_id === chosenId)?.name}</strong>{' '}
          to your quote — you can close this page.
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {options.map((o, i) => {
          const isChosen = chosenId === o.catalogue_id
          const dimmed = chosenId && !isChosen
          return (
            <button
              key={o.catalogue_id}
              type="button"
              disabled={!!chosenId || busy === o.catalogue_id}
              onClick={() => choose(o.catalogue_id)}
              className={`text-left border p-4 transition-colors cursor-pointer disabled:cursor-default ${
                isChosen
                  ? 'border-accent bg-accent/10'
                  : dimmed
                    ? 'border-ink-line bg-ink-card opacity-50'
                    : 'border-ink-line bg-ink-card hover:border-accent/60'
              }`}
            >
              <div className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">
                {options.length === 1
                  ? 'Your product'
                  : i === 0
                    ? 'Option 1 · Good'
                    : 'Option 2 · Better'}
              </div>
              {o.image_path ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={o.image_path}
                  alt={o.name}
                  className="mt-3 h-40 w-full object-cover border border-ink-line bg-ink-deep"
                />
              ) : (
                <div className="mt-3 h-40 w-full border border-ink-line bg-ink-deep flex items-center justify-center font-mono text-[0.65rem] uppercase tracking-[0.15em] text-text-dim">
                  No photo
                </div>
              )}
              <div className="mt-3 font-semibold text-text-pri">{o.name}</div>
              {(o.brand || o.range_series) && (
                <div className="text-xs text-text-dim">
                  {[o.brand, o.range_series].filter(Boolean).join(' ')}
                </div>
              )}
              {o.description && (
                <div className="mt-1 text-xs text-text-sec">{o.description}</div>
              )}
              <div className="mt-2 font-mono text-sm text-accent">
                ${o.price_ex_gst.toFixed(0)}
              </div>
              {busy === o.catalogue_id && (
                <div className="mt-2 font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">
                  Saving…
                </div>
              )}
            </button>
          )
        })}
      </div>
      {!chosenId && (
        <button
          type="button"
          disabled={!!busy}
          onClick={chooseDefer}
          className="mt-4 w-full text-center border border-ink-line bg-ink-card px-4 py-3 text-sm text-text-sec hover:border-accent/50 hover:text-text-pri transition-colors cursor-pointer disabled:opacity-50"
        >
          {busy === '__defer__'
            ? 'Saving…'
            : "No preference — let my tradie choose (recommended)"}
        </button>
      )}
      {error && <p className="mt-4 text-sm text-warning">{error}</p>}
    </div>
  )
}
