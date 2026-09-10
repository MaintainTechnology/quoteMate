'use client'

// Tradie "Edit quote" action on the /p review page. Lets the painter override
// each tier's customer-visible label, scope sentence, and inc-GST price BEFORE
// sending, via POST /api/painting/edit/[estimate_token]. On save it refreshes
// the server tree so the breakdown above re-renders with the new numbers.
//
// Maintain Technology brand: dark navy, vibrant orange accent, mono uppercase.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { getAuthToken } from '@/lib/auth/client-token'

export type EditableTier = {
  tier: 'good' | 'better' | 'best'
  label: string
  scope: string
  inc_gst: number
}

type Draft = { label: string; scope: string; inc_gst: string }

const money = (n: number) =>
  n.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

export function EditQuotePanel({
  estimateToken,
  tiers,
  expectedVersion,
  released,
}: {
  estimateToken: string
  tiers: EditableTier[]
  expectedVersion: string
  released: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [err, setErr] = useState<string | null>(null)
  const [approved,setApproved] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      tiers.map((t) => [t.tier, { label: t.label, scope: t.scope, inc_gst: String(Math.round(t.inc_gst)) }]),
    ),
  )

  const reset = () => {
    setDrafts(
      Object.fromEntries(
        tiers.map((t) => [t.tier, { label: t.label, scope: t.scope, inc_gst: String(Math.round(t.inc_gst)) }]),
      ),
    )
    setErr(null)
    setApproved(false)
    setState('idle')
  }

  const setField = (tier: string, field: keyof Draft, value: string) => {
    setApproved(false)
    setDrafts((d) => ({ ...d, [tier]: { ...d[tier], [field]: value } }))
  }

  const save = async () => {
    setState('saving')
    setErr(null)
    const payload = {
      expectedVersion, approveChanges: approved,
      tiers: tiers.map((t) => {
        const d = drafts[t.tier]
        const cleaned = d.inc_gst.replace(/[^0-9.]/g, '')
        const inc = Number(cleaned)
        const out: { tier: EditableTier['tier']; label: string; scope: string; inc_gst?: number } = {
          tier: t.tier,
          label: d.label.trim(),
          scope: d.scope.trim(),
        }
        // Only send a price when the field holds a valid positive number. A
        // blank or cleared field means "leave this tier's price unchanged" —
        // never zero it out.
        if (cleaned !== '' && Number.isFinite(inc) && inc > 0) out.inc_gst = inc
        return out
      }),
    }
    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in to edit this quote.')
      if (released && !approved) throw new Error('Review and approve the revised prices and scope before saving.')
      const res = await fetch(`/api/painting/edit/${estimateToken}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })
      const j = await res.json()
      if (j.ok) {
        setOpen(false)
        setState('idle')
        router.refresh()
      } else {
        setState('error')
        setErr(j.hint ?? j.error ?? 'Could not save the changes.')
      }
    } catch (e) {
      setState('error')
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          reset()
          setOpen(true)
        }}
        className="inline-flex items-center gap-2 border border-ink-line px-5 py-3 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-text-pri transition-colors hover:border-accent hover:text-accent"
      >
        Edit quote <span aria-hidden="true">✎</span>
      </button>
    )
  }

  return (
    <div className="w-full border border-ink-line border-l-4 border-l-accent bg-ink-deep p-5 sm:p-6">
      <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-accent">
        Edit quote
      </div>
      <p className="mt-2 text-sm leading-relaxed text-text-sec">
        Adjust the name, scope and price for each option. The customer sees these exact figures (inc GST)
        once you send — ex-GST and the range update automatically.
      </p>

      <div className="mt-5 grid gap-5 md:grid-cols-3">
        {tiers.map((t) => {
          const d = drafts[t.tier]
          return (
            <div key={t.tier} className="border border-ink-line bg-ink-card p-4">
              <div className="font-mono text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
                {t.tier} · was ${money(t.inc_gst)}
              </div>

              <label
                htmlFor={`${t.tier}-label`}
                className="mt-3 block font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim"
              >
                {t.tier} · option name
              </label>
              <input
                id={`${t.tier}-label`}
                type="text"
                value={d.label}
                onChange={(e) => setField(t.tier, 'label', e.target.value)}
                className="mt-1 w-full border border-ink-line bg-ink-deep px-3 py-2 font-mono text-sm text-text-pri outline-none focus:border-accent"
              />

              <label
                htmlFor={`${t.tier}-price`}
                className="mt-3 block font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim"
              >
                {t.tier} · price (inc GST)
              </label>
              <div className="mt-1 flex items-center border border-ink-line bg-ink-deep focus-within:border-accent">
                <span className="pl-3 font-mono text-sm text-text-dim">$</span>
                <input
                  id={`${t.tier}-price`}
                  type="text"
                  inputMode="decimal"
                  value={d.inc_gst}
                  onChange={(e) => setField(t.tier, 'inc_gst', e.target.value)}
                  className="w-full bg-transparent px-2 py-2 font-mono text-sm tabular-nums text-text-pri outline-none"
                />
              </div>

              <label
                htmlFor={`${t.tier}-scope`}
                className="mt-3 block font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim"
              >
                {t.tier} · what&apos;s included
              </label>
              <textarea
                id={`${t.tier}-scope`}
                value={d.scope}
                onChange={(e) => setField(t.tier, 'scope', e.target.value)}
                rows={3}
                className="mt-1 w-full resize-y border border-ink-line bg-ink-deep px-3 py-2 text-sm leading-relaxed text-text-sec outline-none focus:border-accent"
              />
            </div>
          )
        })}
      </div>

      {released && <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={approved} onChange={event=>setApproved(event.target.checked)} />I have reviewed and approve these revised prices and scope for the customer.</label>}
      {err && <p className="mt-4 text-sm text-warning">{err}</p>}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={state === 'saving' || (released && !approved)}
          className="inline-flex items-center gap-2 bg-accent px-6 py-3 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-white transition-colors hover:bg-accent-press disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state === 'saving' ? 'Saving…' : released ? 'Apply approved changes' : 'Save draft changes'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            reset()
          }}
          disabled={state === 'saving'}
          className="inline-flex items-center gap-2 border border-ink-line px-5 py-3 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-text-pri transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
