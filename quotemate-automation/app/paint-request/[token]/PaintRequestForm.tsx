'use client'

// Public self-serve painting form (the SMS receptionist's "fill this in"
// link). Mirrors the dashboard Paint estimate form fields so a customer
// supplies exactly what the estimate needs, then POSTs to
// /api/paint-request/[token], which estimates + texts the quote back.

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AddressAutocomplete } from '@/app/dashboard/roofing/_components/AddressAutocomplete'
import type { PaintScope } from '@/lib/painting/types'

const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'] as const

const SCOPES: ReadonlyArray<readonly [PaintScope, string]> = [
  ['walls', 'Interior walls'],
  ['ceilings', 'Ceilings'],
  ['trim', 'Trim (skirting / architraves)'],
  ['exterior', 'Exterior'],
]
const CONDITIONS = [
  ['sound', 'Sound — previously painted'],
  ['minor', 'Minor patching'],
  ['bare', 'Bare / new — needs priming'],
  ['poor', 'Poor — flaking / damage (forces inspection)'],
] as const
const CEILINGS = [
  ['standard', 'Standard (~2.4 m)'],
  ['high', 'High (~2.7 m, Queenslander / period)'],
  ['extra_high', 'Very high (~3 m+, forces inspection)'],
  ['raked', 'Raked / cathedral (forces inspection)'],
] as const

const INPUT =
  'w-full border border-ink-line bg-ink-deep px-4 py-3 font-mono text-base text-text-pri placeholder:text-text-dim focus:border-accent focus:outline-none'

type Ctx = { businessName: string | null; status: string }

export function PaintRequestForm({ token }: { token: string }) {
  const [ctx, setCtx] = useState<Ctx | 'loading' | 'invalid'>('loading')
  const [address, setAddress] = useState('')
  const [postcode, setPostcode] = useState('')
  const [stateCode, setStateCode] = useState<(typeof STATES)[number]>('QLD')
  const [scopes, setScopes] = useState<PaintScope[]>(['walls', 'ceilings'])
  const [coats, setCoats] = useState<1 | 2 | 3>(2)
  const [condition, setCondition] = useState<(typeof CONDITIONS)[number][0]>('sound')
  const [ceiling, setCeiling] = useState<(typeof CEILINGS)[number][0]>('standard')
  const [storeys, setStoreys] = useState<1 | 2 | 3>(1)
  const [colourChange, setColourChange] = useState(false)
  const [manualArea, setManualArea] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ inspection: boolean } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/paint-request/${token}`)
      .then(async (r) => {
        const j = await r.json()
        if (j.ok) setCtx({ businessName: j.business_name ?? null, status: j.status })
        else setCtx('invalid')
      })
      .catch(() => setCtx('invalid'))
  }, [token])

  const toggleScope = useCallback((s: PaintScope) => {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))
  }, [])

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      if (!address.trim()) return setErr('Enter a property address.')
      if (!/^\d{4}$/.test(postcode)) return setErr('Enter a 4-digit postcode.')
      if (scopes.length === 0) return setErr('Pick at least one surface to paint.')
      setBusy(true)
      setErr(null)
      try {
        const res = await fetch(`/api/paint-request/${token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: { address, postcode, state: stateCode },
            inputs: {
              scopes,
              coats,
              condition,
              ceiling_height: ceiling,
              storeys,
              colour_change: colourChange,
              manual_floor_area_m2: manualArea ? Number(manualArea) : null,
            },
          }),
        })
        const j = await res.json()
        if (j.ok) setDone({ inspection: !!j.inspection })
        else if (j.error === 'already_submitted') setErr('This form has already been submitted.')
        else setErr('Sorry, we could not submit that — please try again.')
      } catch (e2) {
        setErr(e2 instanceof Error ? e2.message : String(e2))
      } finally {
        setBusy(false)
      }
    },
    [token, address, postcode, stateCode, scopes, coats, condition, ceiling, storeys, colourChange, manualArea],
  )

  if (ctx === 'loading') return <Shell><p className="qm-loading text-text-sec">Loading…</p></Shell>
  if (ctx === 'invalid') return <Shell><p className="text-warning">This link is invalid or has expired.</p></Shell>

  const business = ctx.businessName
  if (done) return <Shell business={business}><ThankYou inspection={done.inspection} /></Shell>
  if (ctx.status === 'submitted') return <Shell business={business}><ThankYou inspection={false} /></Shell>

  return (
    <Shell business={business}>
      <h1 className="font-extrabold uppercase leading-[0.95] tracking-[-0.03em] text-[clamp(2rem,5vw,3.25rem)]">
        Your painting <span className="text-accent">quote</span>
      </h1>
      <p className="mt-3 max-w-lg text-base leading-relaxed text-text-sec">
        Fill in a few details and we&rsquo;ll text your Good / Better / Best quote straight back.
      </p>

      <form onSubmit={submit} className="mt-8 grid gap-6 border border-ink-line bg-ink-card p-6 sm:p-8 md:grid-cols-2">
        <div className="md:col-span-2">
          <Label>Property address</Label>
          <AddressAutocomplete
            accessToken={null}
            auth={false}
            endpoint={`/api/paint-request/${token}/suggest-address`}
            value={address}
            onChange={setAddress}
            onSelect={(s) => {
              setAddress(s.address)
              // Symmetric guards (same as the dashboard forms): a malformed
              // provider value is ignored, leaving whatever the customer typed.
              if (s.postcode && /^\d{4}$/.test(s.postcode)) setPostcode(s.postcode)
              if (s.state && (STATES as readonly string[]).includes(s.state)) {
                setStateCode(s.state as (typeof STATES)[number])
              }
            }}
            state={stateCode}
            placeholder="28 Greens Rd, Coorparoo"
          />
        </div>
        <div>
          <Label>Postcode</Label>
          <input value={postcode} onChange={(e) => setPostcode(e.target.value.trim())} placeholder="4151" pattern="\d{4}" maxLength={4} className={INPUT} />
        </div>
        <div>
          <Label>State</Label>
          <select aria-label="State" value={stateCode} onChange={(e) => setStateCode(e.target.value as (typeof STATES)[number])} className={INPUT}>
            {STATES.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </div>
        <div className="md:col-span-2">
          <Label>Surfaces to paint</Label>
          <div className="flex flex-wrap gap-3">
            {SCOPES.map(([v, label]) => (
              <label key={v} className={`inline-flex cursor-pointer items-center gap-2.5 border px-4 py-2.5 transition-colors ${scopes.includes(v) ? 'border-accent text-text-pri' : 'border-ink-line text-text-sec hover:border-accent/50'}`}>
                <input type="checkbox" checked={scopes.includes(v)} onChange={() => toggleScope(v)} className="h-4 w-4 accent-accent" />
                <span className="font-mono text-sm font-semibold uppercase tracking-[0.1em]">{label}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <Label>Coats</Label>
          <select aria-label="Coats" value={coats} onChange={(e) => setCoats(Number(e.target.value) as 1 | 2 | 3)} className={INPUT}>
            <option value={1}>1 coat — refresh</option>
            <option value={2}>2 coats — standard</option>
            <option value={3}>3 coats — premium</option>
          </select>
        </div>
        <div>
          <Label>Surface condition</Label>
          <select aria-label="Condition" value={condition} onChange={(e) => setCondition(e.target.value as (typeof CONDITIONS)[number][0])} className={INPUT}>
            {CONDITIONS.map(([v, label]) => (<option key={v} value={v}>{label}</option>))}
          </select>
        </div>
        <div>
          <Label>Ceiling height</Label>
          <select aria-label="Ceiling height" value={ceiling} onChange={(e) => setCeiling(e.target.value as (typeof CEILINGS)[number][0])} className={INPUT}>
            {CEILINGS.map(([v, label]) => (<option key={v} value={v}>{label}</option>))}
          </select>
        </div>
        <div>
          <Label>Storeys</Label>
          <select aria-label="Storeys" value={storeys} onChange={(e) => setStoreys(Number(e.target.value) as 1 | 2 | 3)} className={INPUT}>
            <option value={1}>Single storey</option>
            <option value={2}>Double storey</option>
            <option value={3}>3 storeys (forces inspection)</option>
          </select>
        </div>
        <div>
          <Label>Floor area override (m², optional)</Label>
          <input type="number" min={1} max={2000} value={manualArea} onChange={(e) => setManualArea(e.target.value)} placeholder="from the floor plan" className={INPUT} />
        </div>
        <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-5 pt-1">
          <label className="inline-flex cursor-pointer items-center gap-3 text-text-sec">
            <input type="checkbox" checked={colourChange} onChange={(e) => setColourChange(e.target.checked)} className="h-4 w-4 accent-accent" />
            <span className="font-mono text-sm font-semibold uppercase tracking-[0.12em]">Colour change</span>
          </label>
          <button type="submit" disabled={busy} aria-busy={busy} className="inline-flex items-center gap-2 bg-accent px-6 py-3.5 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-white transition-colors hover:bg-accent-press disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? 'Sending…' : 'Get my quote →'}
          </button>
        </div>
      </form>

      {err && <p className="mt-4 text-sm text-warning">{err}</p>}
    </Shell>
  )
}

function ThankYou({ inspection }: { inspection: boolean }) {
  return (
    <div className="border border-ink-line border-l-4 border-l-accent bg-ink-card p-8">
      <h1 className="font-extrabold uppercase leading-[0.95] tracking-[-0.03em] text-[clamp(1.75rem,4.5vw,2.75rem)]">
        Thanks — <span className="text-accent">got it</span>
      </h1>
      <p className="mt-4 max-w-lg text-base leading-relaxed text-text-sec">
        {inspection
          ? "Thanks for those details. This one needs a quick look on site, so we'll text you to arrange a time."
          : "Your painting draft is saved and awaiting the painter's review. It has not been released as a quote yet."}
      </p>
    </div>
  )
}

function Shell({ children, business }: { children: React.ReactNode; business?: string | null }) {
  return (
    <main className="min-h-screen bg-ink-deep text-text-pri">
      <section className="mx-auto max-w-3xl px-6 py-14 sm:px-10 md:py-20">
        {business && (
          <div className="mb-8 font-mono text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-text-dim">{business}</div>
        )}
        {children}
      </section>
    </main>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-text-dim">{children}</div>
}
