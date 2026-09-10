'use client'

// Public self-serve quote-request form — one form, four trades.
//
// spec: specs/generic-quote-request-form.md §2.
//
// Shared fields first (address, name, best contact time, photos, notes),
// then the block for THIS lead's trade. The trade is resolved server-side
// in page.tsx, so there is no context fetch and no dead-end flash.
//
// Option vocabularies come from lib/quote-request/fields.ts — the same
// module the server-side Zod schemas and the transcript summary read, so
// the browser and the validator cannot drift (PaintRequestForm re-declares
// its lists by hand and keeps them in sync manually).

import { useCallback, useState, type FormEvent } from 'react'
import { AddressAutocomplete } from '@/app/dashboard/roofing/_components/AddressAutocomplete'
import {
  AU_STATES,
  CEILING_TYPE_OPTIONS,
  COLORBOND_PROFILE_OPTIONS,
  CONTACT_TIME_OPTIONS,
  ELECTRICAL_JOB_OPTIONS,
  HOT_WATER_ENERGY_OPTIONS,
  HOT_WATER_LOCATION_OPTIONS,
  PAINT_CEILING_OPTIONS,
  PAINT_COAT_OPTIONS,
  PAINT_CONDITION_OPTIONS,
  PAINT_SCOPE_OPTIONS,
  PLUMBING_JOB_OPTIONS,
  ROOF_INTENT_OPTIONS,
  ROOF_MATERIAL_FAMILY_OPTIONS,
  ROOF_PITCH_OPTIONS,
  STOREY_OPTIONS,
  TRADE_WORD,
  YES_NO_UNSURE_OPTIONS,
  type AuState,
  type CeilingType,
  type ColorbondProfile,
  type ContactTime,
  type ElectricalJob,
  type HotWaterEnergy,
  type HotWaterLocation,
  type Options,
  type PlumbingJob,
  type QuoteRequestTrade,
  type RoofIntent,
  type RoofMaterialFamily,
  type RoofPitch,
  type YesNoUnsure,
} from '@/lib/quote-request/fields'

const INPUT =
  'w-full border border-ink-line bg-ink-deep px-4 py-3 font-mono text-base text-text-pri placeholder:text-text-dim focus:border-accent focus:outline-none'

const MAX_PHOTOS = 5

type PaintScope = 'walls' | 'ceilings' | 'trim' | 'exterior'

export function QuoteRequestForm({
  token,
  trade,
  businessName,
}: {
  token: string
  trade: QuoteRequestTrade
  businessName: string | null
}) {
  // ─── shared ───
  const [address, setAddress] = useState('')
  const [postcode, setPostcode] = useState('')
  const [stateCode, setStateCode] = useState<AuState>('QLD')
  const [firstName, setFirstName] = useState('')
  const [contactTime, setContactTime] = useState<ContactTime>('anytime')
  const [notes, setNotes] = useState('')
  const [photoCount, setPhotoCount] = useState(0)
  const [photoBusy, setPhotoBusy] = useState(false)

  // ─── roofing ───
  const [roofIntent, setRoofIntent] = useState<RoofIntent>('full_reroof')
  const [roofFamily, setRoofFamily] = useState<RoofMaterialFamily>('colorbond')
  const [roofProfile, setRoofProfile] = useState<ColorbondProfile>('colorbond_corrugated')
  const [roofPitch, setRoofPitch] = useState<RoofPitch>('standard')

  // ─── painting ───
  const [scopes, setScopes] = useState<PaintScope[]>(['walls', 'ceilings'])
  const [coats, setCoats] = useState<1 | 2 | 3>(2)
  const [condition, setCondition] = useState<'sound' | 'minor' | 'bare' | 'poor'>('sound')
  const [ceilingHeight, setCeilingHeight] = useState<'standard' | 'high' | 'extra_high' | 'raked'>('standard')
  const [colourChange, setColourChange] = useState(false)
  const [manualArea, setManualArea] = useState('')

  // ─── electrical ───
  const [elecJob, setElecJob] = useState<ElectricalJob>('downlights')
  const [quantity, setQuantity] = useState('')
  const [ceilingType, setCeilingType] = useState<CeilingType>('flat')
  const [switchWithin5m, setSwitchWithin5m] = useState<YesNoUnsure>('unsure')

  // ─── plumbing ───
  const [plumbJob, setPlumbJob] = useState<PlumbingJob>('hot_water')
  const [hwEnergy, setHwEnergy] = useState<HotWaterEnergy>('unsure')
  const [hwCapacity, setHwCapacity] = useState('')
  const [hwLocation, setHwLocation] = useState<HotWaterLocation>('unsure')

  // ─── shared by roofing / painting / electrical ───
  const [storeys, setStoreys] = useState<1 | 2 | 3>(1)

  const [busy, setBusy] = useState(false)
  // `texted` mirrors the API's three-state delivery fact (true / false /
  // null when the async pipeline owns the send). It is carried, not dropped:
  // dropping it is what let a refused Twilio send still render "your quote is
  // on its way to your phone now".
  const [done, setDone] = useState<{ inspection: boolean; texted: boolean | null } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const toggleScope = useCallback((s: PaintScope) => {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))
  }, [])

  const uploadPhotos = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(e.target.files ?? [])
      if (picked.length === 0) return
      if (picked.length > MAX_PHOTOS) return setErr(`Up to ${MAX_PHOTOS} photos at a time.`)
      setPhotoBusy(true)
      setErr(null)
      try {
        const fd = new FormData()
        for (const f of picked) fd.append('photos', f, f.name)
        const res = await fetch(`/api/quote-request/${token}/photos`, { method: 'POST', body: fd })
        const j = await res.json()
        if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
        setPhotoCount((n) => n + (j.count as number))
      } catch (e2) {
        // Photos are optional — never block the quote on them.
        setErr(`Photos did not upload (${e2 instanceof Error ? e2.message : String(e2)}). You can still send the form.`)
      } finally {
        setPhotoBusy(false)
      }
    },
    [token],
  )

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      if (!address.trim()) return setErr('Enter a property address.')
      if (!/^\d{4}$/.test(postcode)) return setErr('Enter a 4-digit postcode.')
      if (trade === 'painting' && scopes.length === 0) return setErr('Pick at least one surface to paint.')

      const inputs =
        trade === 'roofing'
          ? {
              intent: roofIntent,
              material: roofFamily === 'colorbond' ? roofProfile : roofFamily,
              pitch: roofPitch,
              storeys,
            }
          : trade === 'painting'
            ? {
                scopes,
                coats,
                condition,
                ceiling_height: ceilingHeight,
                storeys,
                colour_change: colourChange,
                manual_floor_area_m2: manualArea ? Number(manualArea) : null,
              }
            : trade === 'electrical'
              ? {
                  job_type: elecJob,
                  quantity: quantity ? Number(quantity) : null,
                  ceiling_type: ceilingType,
                  storeys,
                  switch_within_5m: switchWithin5m,
                }
              : {
                  job_type: plumbJob,
                  hot_water_energy: plumbJob === 'hot_water' ? hwEnergy : null,
                  hot_water_capacity_l: plumbJob === 'hot_water' && hwCapacity ? Number(hwCapacity) : null,
                  hot_water_location: plumbJob === 'hot_water' ? hwLocation : null,
                }

      setBusy(true)
      setErr(null)
      try {
        const res = await fetch(`/api/quote-request/${token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: { address, postcode, state: stateCode },
            first_name: firstName.trim() || null,
            contact_time: contactTime,
            notes: notes.trim() || null,
            inputs,
          }),
        })
        const j = await res.json().catch(() => ({ ok: false, error: 'server_error' }))
        // `texted` is tri-state — `?? null` on purpose, so "the async pipeline
        // owns the send" (null) is not flattened into "the send was refused".
        if (res.ok && j.ok) return setDone({ inspection: !!j.inspection, texted: j.texted ?? null })
        // Status-aware, unlike the painting form: a 4xx is something the
        // customer can fix, a 5xx is ours and worth retrying.
        if (j.error === 'already_submitted') setErr('This form has already been sent through.')
        else if (j.error === 'link_expired' || j.error === 'invalid_link') setErr('This link has expired. Reply to our text and we will send a fresh one.')
        else if (res.status >= 500) setErr('Something went wrong on our end. Give it another go in a moment.')
        else setErr('Some of those details did not look right. Check the form and try again.')
      } catch (e2) {
        setErr(e2 instanceof Error ? e2.message : String(e2))
      } finally {
        setBusy(false)
      }
    },
    [
      token, trade, address, postcode, stateCode, firstName, contactTime, notes,
      roofIntent, roofFamily, roofProfile, roofPitch,
      scopes, coats, condition, ceilingHeight, colourChange, manualArea,
      elecJob, quantity, ceilingType, switchWithin5m,
      plumbJob, hwEnergy, hwCapacity, hwLocation,
      storeys,
    ],
  )

  if (done) {
    return (
      <Shell business={businessName}>
        <ThankYou inspection={done.inspection} texted={done.texted} />
      </Shell>
    )
  }

  return (
    <Shell business={businessName}>
      <h1 className="font-extrabold uppercase leading-[0.95] tracking-[-0.03em] text-[clamp(2rem,5vw,3.25rem)]">
        Your {TRADE_WORD[trade]} <span className="text-accent">quote</span>
      </h1>
      <p className="mt-3 max-w-lg text-base leading-relaxed text-text-sec">
        Fill in a few details and we&rsquo;ll text your quote straight back.
      </p>

      <form onSubmit={submit} className="mt-8 grid gap-6 border border-ink-line bg-ink-card p-6 sm:p-8 md:grid-cols-2">
        <div className="md:col-span-2">
          <Label>Property address</Label>
          <AddressAutocomplete
            accessToken={null}
            auth={false}
            endpoint={`/api/quote-request/${token}/suggest-address`}
            value={address}
            onChange={setAddress}
            onSelect={(s) => {
              setAddress(s.address)
              // A malformed provider value is ignored, leaving whatever the
              // customer typed (same guards as the dashboard forms).
              if (s.postcode && /^\d{4}$/.test(s.postcode)) setPostcode(s.postcode)
              if (s.state && (AU_STATES as readonly string[]).includes(s.state)) setStateCode(s.state as AuState)
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
          <select aria-label="State" value={stateCode} onChange={(e) => setStateCode(e.target.value as AuState)} className={INPUT}>
            {AU_STATES.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </div>
        <div>
          <Label>First name</Label>
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Sam" maxLength={80} className={INPUT} />
        </div>
        <Select label="Best time to contact" value={contactTime} options={CONTACT_TIME_OPTIONS} onPick={setContactTime} />

        {trade === 'roofing' && (
          <>
            <Select label="Work needed" value={roofIntent} options={ROOF_INTENT_OPTIONS} onPick={setRoofIntent} />
            <Select label="Current roof material" value={roofFamily} options={ROOF_MATERIAL_FAMILY_OPTIONS} onPick={setRoofFamily} />
            {roofFamily === 'colorbond' && (
              <Select label="Colorbond profile" value={roofProfile} options={COLORBOND_PROFILE_OPTIONS} onPick={setRoofProfile} />
            )}
            <Select label="Roof pitch" value={roofPitch} options={ROOF_PITCH_OPTIONS} onPick={setRoofPitch} />
            <Select label="Storeys" value={storeys} options={STOREY_OPTIONS} onPick={setStoreys} numeric />
          </>
        )}

        {trade === 'painting' && (
          <>
            <div className="md:col-span-2">
              <Label>Surfaces to paint</Label>
              <div className="flex flex-wrap gap-3">
                {PAINT_SCOPE_OPTIONS.map(([v, label]) => (
                  <label key={v} className={`inline-flex cursor-pointer items-center gap-2.5 border px-4 py-2.5 transition-colors ${scopes.includes(v) ? 'border-accent text-text-pri' : 'border-ink-line text-text-sec hover:border-accent/50'}`}>
                    <input type="checkbox" checked={scopes.includes(v)} onChange={() => toggleScope(v)} className="h-4 w-4 accent-accent" />
                    <span className="font-mono text-sm font-semibold uppercase tracking-[0.1em]">{label}</span>
                  </label>
                ))}
              </div>
            </div>
            <Select label="Coats" value={coats} options={PAINT_COAT_OPTIONS} onPick={setCoats} numeric />
            <Select label="Surface condition" value={condition} options={PAINT_CONDITION_OPTIONS} onPick={setCondition} />
            <Select label="Ceiling height" value={ceilingHeight} options={PAINT_CEILING_OPTIONS} onPick={setCeilingHeight} />
            <Select label="Storeys" value={storeys} options={STOREY_OPTIONS} onPick={setStoreys} numeric />
            <div>
              <Label>Floor area override (m², optional)</Label>
              <input type="number" min={1} max={2000} value={manualArea} onChange={(e) => setManualArea(e.target.value)} placeholder="from the floor plan" className={INPUT} />
            </div>
            <label className="inline-flex cursor-pointer items-center gap-3 self-end pb-3 text-text-sec">
              <input type="checkbox" checked={colourChange} onChange={(e) => setColourChange(e.target.checked)} className="h-4 w-4 accent-accent" />
              <span className="font-mono text-sm font-semibold uppercase tracking-[0.12em]">Colour change</span>
            </label>
          </>
        )}

        {trade === 'electrical' && (
          <>
            <Select label="What do you need done" value={elecJob} options={ELECTRICAL_JOB_OPTIONS} onPick={setElecJob} />
            <div>
              <Label>How many</Label>
              <input type="number" min={1} max={200} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="e.g. 12" className={INPUT} />
            </div>
            <Select label="Ceiling type" value={ceilingType} options={CEILING_TYPE_OPTIONS} onPick={setCeilingType} />
            <Select label="Storeys" value={storeys} options={STOREY_OPTIONS} onPick={setStoreys} numeric />
            <Select label="Existing switch within 5 m" value={switchWithin5m} options={YES_NO_UNSURE_OPTIONS} onPick={setSwitchWithin5m} />
          </>
        )}

        {trade === 'plumbing' && (
          <>
            <Select label="What do you need done" value={plumbJob} options={PLUMBING_JOB_OPTIONS} onPick={setPlumbJob} />
            {plumbJob === 'hot_water' && (
              <>
                <Select label="Gas or electric" value={hwEnergy} options={HOT_WATER_ENERGY_OPTIONS} onPick={setHwEnergy} />
                <div>
                  <Label>Capacity (litres, optional)</Label>
                  <input type="number" min={10} max={1000} value={hwCapacity} onChange={(e) => setHwCapacity(e.target.value)} placeholder="e.g. 250" className={INPUT} />
                </div>
                <Select label="Indoors or outdoors" value={hwLocation} options={HOT_WATER_LOCATION_OPTIONS} onPick={setHwLocation} />
              </>
            )}
          </>
        )}

        <div className="md:col-span-2">
          <Label>Photos (optional)</Label>
          <label className="flex cursor-pointer items-center justify-between gap-4 border border-dashed border-ink-line bg-ink-deep px-4 py-3.5 transition-colors hover:border-accent">
            <span className="font-mono text-sm uppercase tracking-[0.12em] text-text-sec">
              {photoBusy ? 'Uploading…' : photoCount > 0 ? `${photoCount} photo${photoCount > 1 ? 's' : ''} attached` : 'Add photos'}
            </span>
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-text-dim">JPEG · PNG · WebP · max 5</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={uploadPhotos} className="sr-only" />
          </label>
        </div>

        <div className="md:col-span-2">
          <Label>Anything else we should know (optional)</Label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={1000} placeholder="Access, timing, anything unusual" className={INPUT} />
        </div>

        <div className="md:col-span-2 flex justify-end pt-1">
          <button type="submit" disabled={busy} aria-busy={busy} className="inline-flex items-center gap-2 bg-accent px-6 py-3.5 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-white transition-colors hover:bg-accent-press disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? 'Sending…' : 'Get my quote →'}
          </button>
        </div>
      </form>

      {err && <p className="mt-4 text-sm text-warning">{err}</p>}
    </Shell>
  )
}

/** One labelled <select>. `numeric` coerces the value back to a number so
 *  storey/coat counts stay 1|2|3 and not "1"|"2"|"3". */
function Select<T extends string | number>({
  label,
  value,
  options,
  onPick,
  numeric,
}: {
  label: string
  value: T
  options: Options<T>
  onPick: (v: T) => void
  numeric?: boolean
}) {
  return (
    <div>
      <Label>{label}</Label>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onPick((numeric ? Number(e.target.value) : e.target.value) as T)}
        className={INPUT}
      >
        {options.map(([v, l]) => (
          <option key={String(v)} value={v}>{l}</option>
        ))}
      </select>
    </div>
  )
}

/**
 * Post-submit copy. `texted` is the API's delivery fact:
 *   false → a send was attempted and REFUSED. Checked first, and it beats
 *           `inspection`, because both other lines promise the customer a
 *           text ("on its way", "we'll text you") that is not coming.
 *   true / null → something was sent, or the async intake pipeline owns the
 *           send; "on its way" is true in both cases.
 * The page must never state a delivery the API reported as false — that is
 * the incident this branch exists for.
 */
export function ThankYou({ inspection, texted }: { inspection: boolean; texted?: boolean | null }) {
  return (
    <div className="border border-ink-line border-l-4 border-l-accent bg-ink-card p-8">
      <h1 className="font-extrabold uppercase leading-[0.95] tracking-[-0.03em] text-[clamp(1.75rem,4.5vw,2.75rem)]">
        Thanks, <span className="text-accent">got it</span>
      </h1>
      <p className="mt-4 max-w-lg text-base leading-relaxed text-text-sec">
        {texted === false
          ? "Your details are saved. The tradie needs to review the draft before a quote can be shared."
          : inspection
            ? 'Thanks for those details. An on-site assessment needs tradie review before an appointment can be arranged.'
            : "Your details have been received. Quote preparation and tradie review still need to complete before a quote can be shared."}
      </p>
    </div>
  )
}

/** Friendly dead-end for a link that is not usable. Always rendered with a
 *  200 — a customer following an SMS link never sees a raw 404. */
export function DeadEnd({ message }: { message: string }) {
  return (
    <div className="border border-ink-line border-l-4 border-l-warning bg-ink-card p-8">
      <h1 className="font-extrabold uppercase leading-[0.95] tracking-[-0.03em] text-[clamp(1.75rem,4.5vw,2.75rem)]">
        Link <span className="text-accent">not active</span>
      </h1>
      <p className="mt-4 max-w-lg text-base leading-relaxed text-text-sec">{message}</p>
    </div>
  )
}

export function Shell({ children, business }: { children: React.ReactNode; business?: string | null }) {
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
