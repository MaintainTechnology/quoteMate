// /onboard — Maintain design system. 3-step wizard after sign up.
//
// Step 1: Trade + state + mobile + optional licence
// Step 2: Pricing essentials + collapsible advanced
// Step 3: Review + Activate

'use client'

import { Suspense, useState, useEffect, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { LICENCE_BODIES } from '@/lib/onboard/schema'
import { Field, INPUT, ErrorBanner, Arrow } from '../signup/page'

type FormState = {
  business_name: string
  owner_first_name: string
  owner_email: string
  owner_user_id: string
  owner_mobile: string
  trade: 'electrical' | 'plumbing' | ''
  state: 'NSW' | 'VIC' | 'QLD' | 'WA' | 'SA' | 'TAS' | 'ACT' | 'NT' | ''
  abn: string
  licence_type: string
  licence_number: string
  licence_expiry: string
  hourly_rate: string
  call_out_minimum: string
  default_markup_pct: string
  apprentice_rate: string
  senior_rate: string
  after_hours_multiplier: string
  min_labour_hours: string
  risk_buffer_pct: string
  gst_registered: boolean
}

const STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'] as const

const STEP_META = [
  { num: '02', label: 'Trade & licence', subtitle: 'What you do, where, optional regulatory bits.' },
  { num: '03', label: 'Your pricing',    subtitle: 'Three required fields. Advanced settings have defaults.' },
  { num: '04', label: 'Review & activate', subtitle: 'One last look, then we provision your AI line.' },
] as const

// Next.js 16 disallows prerendering pages whose default export reads
// useSearchParams() without a Suspense boundary. The wizard reads
// ?intent, ?owner_mobile, ?tenant, plus the carry-over identity fields
// from /auth/callback — all request-time only. Inner component owns
// that logic; this wrapper provides the boundary.
export default function OnboardWizard() {
  return (
    <Suspense fallback={null}>
      <OnboardWizardInner />
    </Suspense>
  )
}

function OnboardWizardInner() {
  const router = useRouter()
  const params = useSearchParams()

  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [showAdvanced, setShowAdvanced] = useState(false)
  // Licence details collapse — defaults to hidden so tradies see a clean
  // Step 1 with only the truly required fields (mobile + trade + state).
  // Anyone with a licence number can click to expand and fill it in.
  const [showLicence, setShowLicence] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  // Mobile lock — set when the tradie's mobile has already been
  // verified before reaching the wizard. Two upstream sources:
  //
  //   1. SMS-initiated path: tradie texted the shared QuoteMate
  //      number, mobile proven by physical possession. intent token
  //      is present; flipped on activate via markIntentUsed.
  //
  //   2. Web-initiated path: tradie entered mobile on /signup, got a
  //      6-digit OTP via Twilio, typed it into /signup/verify. No
  //      intent token, but owner_mobile is in the URL — Supabase has
  //      phone_confirmed_at set, so we know it's real.
  //
  // Either case → mobile field is read-only in the wizard.
  const intentToken = params.get('intent') ?? ''
  const mobileFromUpstream = params.get('owner_mobile') ?? ''
  const mobileLocked = !!mobileFromUpstream

  const [form, setForm] = useState<FormState>({
    business_name: '',
    owner_first_name: '',
    owner_email: '',
    owner_user_id: '',
    owner_mobile: '',
    trade: '',
    state: '',
    abn: '',
    licence_type: '',
    licence_number: '',
    licence_expiry: '',
    hourly_rate: '',
    call_out_minimum: '',
    default_markup_pct: '',
    apprentice_rate: '',
    senior_rate: '',
    after_hours_multiplier: '',
    min_labour_hours: '',
    risk_buffer_pct: '',
    gst_registered: true,
  })

  // Hydrate identity fields. Source priority:
  //   1. URL params (carried over from /signup or /auth/callback)
  //   2. Supabase session user + user_metadata (set by /api/auth/signup)
  //
  // The session fallback is critical — without it, returning users
  // arriving from /signin (which only passes owner_user_id) would
  // submit blank business_name/first_name/email and hit a Zod 400.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Pass 1 — URL params (fast, no network)
      const urlBn = params.get('business_name') ?? ''
      const urlFn = params.get('owner_first_name') ?? ''
      const urlEmail = params.get('owner_email') ?? ''
      const urlUserId = params.get('owner_user_id') ?? ''
      const urlMobile = params.get('owner_mobile') ?? ''

      if (!cancelled) {
        setForm((prev) => ({
          ...prev,
          business_name: urlBn || prev.business_name,
          owner_first_name: urlFn || prev.owner_first_name,
          owner_email: urlEmail || prev.owner_email,
          owner_user_id: urlUserId || prev.owner_user_id,
          owner_mobile: urlMobile || prev.owner_mobile,
        }))
      }

      // Pass 2 — Supabase session backfill for anything still empty
      if (urlBn && urlFn && urlEmail && urlUserId) {
        return // everything came through the URL, no need to fetch
      }
      try {
        const { getBrowserSupabase } = await import('@/lib/supabase/client')
        const supabase = getBrowserSupabase()
        const {
          data: { user },
        } = await supabase.auth.getUser()
        if (cancelled || !user) return

        const meta = (user.user_metadata ?? {}) as {
          business_name?: string
          first_name?: string
          owner_mobile?: string
        }
        setForm((prev) => ({
          ...prev,
          business_name: prev.business_name || meta.business_name || '',
          owner_first_name: prev.owner_first_name || meta.first_name || '',
          owner_email: prev.owner_email || user.email || '',
          owner_user_id: prev.owner_user_id || user.id,
          owner_mobile: prev.owner_mobile || meta.owner_mobile || '',
        }))
      } catch (e) {
        // Non-fatal — wizard will show validation errors on submit if
        // the user still has empty required identity fields.
        console.warn('[onboard] session backfill failed', e)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const canContinueStep1 = !!(form.owner_mobile && form.trade && form.state)
  const canContinueStep2 = !!(form.hourly_rate && form.call_out_minimum && form.default_markup_pct)

  async function handleActivate(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    setFieldErrors({})
    try {
      const payload = {
        ...form,
        trade: form.trade as 'electrical' | 'plumbing',
        state: form.state as 'NSW',
        // Pass through the SMS intent token so the API marks it used
        // and back-links the originating SMS conversation.
        intent_token: intentToken || undefined,
      }
      const res = await fetch('/api/onboard/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!data.ok) {
        if (data.fieldErrors) setFieldErrors(data.fieldErrors)
        // Build a human-readable message for validation_failed so the
        // user sees WHICH fields broke without opening DevTools. For
        // identity fields (business_name, first_name, email, mobile)
        // we also suggest signing in again — the most common cause is
        // missing URL carry-through.
        if (data.error === 'validation_failed' && data.fieldErrors) {
          const fields = Object.keys(data.fieldErrors)
          const identityFields = ['business_name', 'owner_first_name', 'owner_email', 'owner_mobile', 'owner_user_id']
          const missingIdentity = fields.filter((f) => identityFields.includes(f))
          if (missingIdentity.length > 0) {
            throw new Error(
              `Your account details didn't carry over from signup (${missingIdentity.join(', ')}). ` +
                `Try refreshing this page — we now pull them from your active session as a fallback.`,
            )
          }
          const summary = fields
            .map((f) => `${f}: ${data.fieldErrors[f]?.[0] ?? 'invalid'}`)
            .join(' · ')
          throw new Error(`Please fix: ${summary}`)
        }
        throw new Error(data.error ?? 'Activation failed')
      }
      const sp = new URLSearchParams({
        tenant: data.tenantId,
        phone: data.phoneNumber ?? '',
        name: form.owner_first_name,
      })
      router.push(`/onboard/success?${sp.toString()}`)
    } catch (err: any) {
      setError(err?.message ?? 'Activation failed')
      setSubmitting(false)
    }
  }

  const meta = STEP_META[step - 1]

  return (
    <main className="min-h-screen flex flex-col">
      {/* nav */}
      <nav className="border-b border-ink-line">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center bg-accent font-black text-white text-xs">
              Q
            </span>
            <span className="font-extrabold uppercase tracking-tight text-text-pri">
              QuoteMate
            </span>
          </Link>
          <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim">
            Step {meta.num} of 04
          </span>
        </div>
      </nav>

      <div className="flex-1 flex items-start justify-center px-6 py-12 md:py-16">
        <div className="w-full max-w-2xl">
          <ProgressDots current={step} />

          {/* Signature numbered step card */}
          <div className="mt-10">
            <div className="flex items-start gap-6 md:gap-8">
              <span className="font-mono text-5xl md:text-7xl font-bold text-accent leading-none shrink-0">
                {meta.num}
              </span>
              <div className="pt-1.5">
                <h1 className="font-extrabold uppercase text-[clamp(1.75rem,4vw,2.75rem)] leading-[1.05] tracking-[-0.03em]">
                  {meta.label}
                </h1>
                <p className="mt-3 text-text-sec leading-relaxed">{meta.subtitle}</p>
              </div>
            </div>
          </div>

          {/* Step content */}
          <div className="mt-10 bg-ink-card border border-ink-line p-6 md:p-8">
            {step === 1 && (
              <Step1
                form={form}
                update={update}
                fieldErrors={fieldErrors}
                mobileLocked={mobileLocked}
                showLicence={showLicence}
                setShowLicence={setShowLicence}
              />
            )}
            {step === 2 && (
              <Step2
                form={form}
                update={update}
                fieldErrors={fieldErrors}
                showAdvanced={showAdvanced}
                setShowAdvanced={setShowAdvanced}
              />
            )}
            {step === 3 && (
              <Step3 form={form} />
            )}
          </div>

          {/* Inline error */}
          {error && (
            <div className="mt-6">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}

          {/* Footer nav */}
          <div className="mt-8 flex items-center justify-between gap-3">
            {step > 1 ? (
              <SecondaryButton onClick={() => setStep((s) => (s - 1) as 1 | 2)}>Back</SecondaryButton>
            ) : (
              <span />
            )}
            {step === 1 && (
              <PrimaryButton
                disabled={!canContinueStep1}
                onClick={() => setStep(2)}
              >
                Continue
              </PrimaryButton>
            )}
            {step === 2 && (
              <PrimaryButton
                disabled={!canContinueStep2}
                onClick={() => setStep(3)}
              >
                Continue
              </PrimaryButton>
            )}
            {step === 3 && (
              <form onSubmit={handleActivate}>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-7 py-3.5 text-sm uppercase tracking-wider transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-accent-soft focus:ring-offset-2 focus:ring-offset-ink-deep"
                >
                  {submitting ? 'Activating…' : 'Activate my QuoteMate'}
                  {!submitting && <Arrow />}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}

/* ─── Step content ──────────────────────────────────────────── */

function Step1({
  form,
  update,
  fieldErrors,
  mobileLocked,
  showLicence,
  setShowLicence,
}: {
  form: FormState
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void
  fieldErrors: Record<string, string[]>
  mobileLocked: boolean
  showLicence: boolean
  setShowLicence: (v: boolean) => void
}) {
  return (
    <>
      {/* Required + commonly-asked fields */}
      <div className="grid gap-5 md:grid-cols-2">
        <Field
          label="Mobile"
          hint={mobileLocked ? 'Verified via your SMS — locked' : 'For your welcome text'}
          error={fieldErrors.owner_mobile?.[0]}
        >
          <input
            type="tel"
            value={form.owner_mobile}
            onChange={(e) => update('owner_mobile', e.target.value)}
            placeholder="04xx xxx xxx"
            className={`${INPUT} ${mobileLocked ? 'opacity-70 cursor-not-allowed' : ''}`}
            autoComplete="tel"
            required
            readOnly={mobileLocked}
          />
        </Field>

        <Field label="Trade" error={fieldErrors.trade?.[0]}>
          <div className="grid grid-cols-2 gap-2">
            <TradePill value="electrical" label="Electrical" current={form.trade} onPick={(v) => update('trade', v)} />
            <TradePill value="plumbing" label="Plumbing" current={form.trade} onPick={(v) => update('trade', v)} />
          </div>
        </Field>

        <Field label="State">
          <select
            value={form.state}
            onChange={(e) => update('state', e.target.value as FormState['state'])}
            className={INPUT}
            required
          >
            <option value="" className="bg-ink-deep">Choose state</option>
            {STATES.map((s) => <option key={s} value={s} className="bg-ink-deep">{s}</option>)}
          </select>
        </Field>

        <Field label="ABN" hint="Optional — add later">
          <input
            type="text"
            value={form.abn}
            onChange={(e) => update('abn', e.target.value)}
            placeholder="11 222 333 444"
            className={INPUT}
            maxLength={20}
          />
        </Field>
      </div>

      {/* ─── Licence details — collapsed by default ───────────────── */}
      {/* Licence is optional in the database AND in Australian Consumer
          Law for the test phase. Most tradies have one but typing it
          mid-onboarding is friction — let them skip cleanly and add it
          later from the dashboard's Account tab. */}
      <div className="mt-6 pt-6 border-t border-ink-line">
        {!showLicence ? (
          <button
            type="button"
            onClick={() => setShowLicence(true)}
            className="inline-flex items-center gap-2 text-sm font-mono uppercase tracking-[0.14em] text-text-sec hover:text-text-pri transition-colors"
          >
            <span className="text-accent text-base leading-none">+</span>
            Add licence details
            <span className="text-text-dim normal-case font-sans tracking-normal text-xs">(optional, can add later)</span>
          </button>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <h3 className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-text-pri font-bold">
                Licence details
                <span className="ml-2 text-text-dim font-normal normal-case tracking-normal text-xs">
                  (optional)
                </span>
              </h3>
              <button
                type="button"
                onClick={() => setShowLicence(false)}
                className="text-xs font-mono uppercase tracking-[0.14em] text-text-dim hover:text-text-pri"
              >
                Skip
              </button>
            </div>
            <div className="mt-4 grid gap-5 md:grid-cols-2">
              {form.state && form.trade && (
                <Field label="Licence body" hint="Optional">
                  <input
                    type="text"
                    value={form.licence_type || LICENCE_BODIES[form.state]?.[form.trade as 'electrical' | 'plumbing'] || ''}
                    onChange={(e) => update('licence_type', e.target.value)}
                    className={INPUT}
                    placeholder={LICENCE_BODIES[form.state]?.[form.trade as 'electrical' | 'plumbing']}
                  />
                </Field>
              )}

              <Field label="Licence number" hint="Optional">
                <input
                  type="text"
                  value={form.licence_number}
                  onChange={(e) => update('licence_number', e.target.value)}
                  className={INPUT}
                />
              </Field>

              <Field label="Licence expiry" hint="Optional">
                <input
                  type="date"
                  value={form.licence_expiry}
                  onChange={(e) => update('licence_expiry', e.target.value)}
                  className={`${INPUT} [color-scheme:dark]`}
                />
              </Field>
            </div>
          </>
        )}
      </div>
    </>
  )
}

function Step2({
  form,
  update,
  fieldErrors,
  showAdvanced,
  setShowAdvanced,
}: {
  form: FormState
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void
  fieldErrors: Record<string, string[]>
  showAdvanced: boolean
  setShowAdvanced: (v: boolean) => void
}) {
  const isPlumbing = form.trade === 'plumbing'
  return (
    <div className="space-y-5">
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Hourly rate" hint="Ex-GST" error={fieldErrors.hourly_rate?.[0]}>
          <PrefixedInput
            prefix="$"
            type="number"
            step="1"
            min="1"
            value={form.hourly_rate}
            onChange={(v) => update('hourly_rate', v)}
            placeholder={isPlumbing ? '120' : '110'}
          />
        </Field>

        <Field label="Call-out minimum" hint="Absorbed into jobs > $800" error={fieldErrors.call_out_minimum?.[0]}>
          <PrefixedInput
            prefix="$"
            type="number"
            step="1"
            min="1"
            value={form.call_out_minimum}
            onChange={(v) => update('call_out_minimum', v)}
            placeholder={isPlumbing ? '110' : '150'}
          />
        </Field>

        <Field label="Materials markup" hint="20–35% typical AU" error={fieldErrors.default_markup_pct?.[0]}>
          <SuffixedInput
            suffix="%"
            type="number"
            step="1"
            min="0"
            max="100"
            value={form.default_markup_pct}
            onChange={(v) => update('default_markup_pct', v)}
            placeholder={isPlumbing ? '20' : '28'}
          />
        </Field>

        <label className="flex items-center gap-3 text-sm text-text-pri cursor-pointer self-end pb-2">
          <input
            type="checkbox"
            checked={form.gst_registered}
            onChange={(e) => update('gst_registered', e.target.checked)}
            className="h-5 w-5 rounded-none border-ink-line bg-ink-deep text-accent focus:ring-2 focus:ring-accent-soft"
          />
          <span>GST registered</span>
        </label>
      </div>

      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-accent hover:text-accent-press transition-colors"
      >
        {showAdvanced ? '— Hide advanced pricing' : '+ Show advanced pricing (5 optional)'}
      </button>

      {showAdvanced && (
        <div className="grid gap-5 md:grid-cols-2 pt-4 border-t border-ink-line">
          <Field label="Apprentice rate" hint="Default $65/hr">
            <PrefixedInput prefix="$" type="number" step="1" value={form.apprentice_rate} onChange={(v) => update('apprentice_rate', v)} placeholder="65" />
          </Field>
          <Field label="Senior rate" hint="Default $160/hr">
            <PrefixedInput prefix="$" type="number" step="1" value={form.senior_rate} onChange={(v) => update('senior_rate', v)} placeholder="160" />
          </Field>
          <Field label="After-hours multiplier" hint="Default 1.5×">
            <input
              type="number" step="0.1"
              value={form.after_hours_multiplier}
              onChange={(e) => update('after_hours_multiplier', e.target.value)}
              placeholder="1.5"
              className={INPUT}
            />
          </Field>
          <Field label="Minimum charge (hr)" hint={`Default ${isPlumbing ? '1.5' : '2'}hr`}>
            <input
              type="number" step="0.5"
              value={form.min_labour_hours}
              onChange={(e) => update('min_labour_hours', e.target.value)}
              placeholder={isPlumbing ? '1.5' : '2'}
              className={INPUT}
            />
          </Field>
          <Field label="Risk buffer %" hint="Default 15%">
            <SuffixedInput suffix="%" type="number" step="1" value={form.risk_buffer_pct} onChange={(v) => update('risk_buffer_pct', v)} placeholder="15" />
          </Field>
        </div>
      )}
    </div>
  )
}

function Step3({ form }: { form: FormState }) {
  return (
    <div className="space-y-8">
      <ReviewBlock label="Account">
        <ReviewRow k="Business" v={form.business_name} />
        <ReviewRow k="Owner" v={form.owner_first_name} />
        <ReviewRow k="Email" v={form.owner_email} />
        <ReviewRow k="Mobile" v={form.owner_mobile} />
      </ReviewBlock>

      <ReviewBlock label="Trade">
        <ReviewRow k="Trade" v={titleCase(form.trade)} />
        <ReviewRow k="State" v={form.state} />
        {form.abn && <ReviewRow k="ABN" v={form.abn} />}
        {form.licence_number && (
          <ReviewRow k="Licence" v={`${form.licence_type ?? ''} ${form.licence_number}`.trim()} />
        )}
      </ReviewBlock>

      <ReviewBlock label="Pricing">
        <ReviewRow k="Hourly" v={form.hourly_rate ? `$${form.hourly_rate}/hr` : ''} />
        <ReviewRow k="Callout" v={form.call_out_minimum ? `$${form.call_out_minimum}` : ''} />
        <ReviewRow k="Markup" v={form.default_markup_pct ? `${form.default_markup_pct}%` : ''} />
        <ReviewRow k="GST" v={form.gst_registered ? 'Registered' : 'Not registered'} />
      </ReviewBlock>

      <div className="border-t border-ink-line pt-6">
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-text-dim">
          On activation
        </span>
        <ul className="mt-3 space-y-1.5 text-sm text-text-sec">
          <li className="flex gap-3"><span className="text-accent font-mono text-xs pt-0.5">→</span>Account + pricing saved to database</li>
          <li className="flex gap-3"><span className="text-accent font-mono text-xs pt-0.5">→</span>Auto-quote services enabled for your trade</li>
          <li className="flex gap-3"><span className="text-text-dim font-mono text-xs pt-0.5">○</span>Twilio number provisioned (placeholder in test phase)</li>
          <li className="flex gap-3"><span className="text-text-dim font-mono text-xs pt-0.5">○</span>Vapi AI assistant created (placeholder in test phase)</li>
        </ul>
      </div>
    </div>
  )
}

/* ─── Primitives ────────────────────────────────────────────── */

function ProgressDots({ current }: { current: 1 | 2 | 3 }) {
  return (
    <div className="flex items-center gap-3">
      {[1, 2, 3].map((s) => {
        const active = s === current
        const done = s < current
        return (
          <div
            key={s}
            className={`h-1 flex-1 transition-colors ${
              done || active ? 'bg-accent' : 'bg-ink-line'
            }`}
            aria-current={active ? 'step' : undefined}
          />
        )
      })}
    </div>
  )
}

function TradePill({
  value,
  label,
  current,
  onPick,
}: {
  value: 'electrical' | 'plumbing'
  label: string
  current: string
  onPick: (v: 'electrical' | 'plumbing') => void
}) {
  const selected = current === value
  return (
    <button
      type="button"
      onClick={() => onPick(value)}
      className={`px-4 py-3.5 text-sm font-semibold uppercase tracking-wider transition-colors border ${
        selected
          ? 'border-accent bg-accent text-white'
          : 'border-ink-line bg-ink-deep text-text-sec hover:border-accent-soft hover:text-text-pri'
      }`}
    >
      {label}
    </button>
  )
}

type AffixInputProps = {
  value: string
  onChange: (v: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>

function PrefixedInput({
  prefix,
  value,
  onChange,
  ...rest
}: AffixInputProps & { prefix: string }) {
  return (
    <div className="flex">
      <span className="inline-flex items-center justify-center bg-ink-deep border border-r-0 border-ink-line px-3.5 text-text-dim font-mono text-sm">
        {prefix}
      </span>
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT} flex-1`}
      />
    </div>
  )
}

function SuffixedInput({
  suffix,
  value,
  onChange,
  ...rest
}: AffixInputProps & { suffix: string }) {
  return (
    <div className="flex">
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT} flex-1`}
      />
      <span className="inline-flex items-center justify-center bg-ink-deep border border-l-0 border-ink-line px-3.5 text-text-dim font-mono text-sm">
        {suffix}
      </span>
    </div>
  )
}

function PrimaryButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-7 py-3.5 text-sm uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-accent-soft focus:ring-offset-2 focus:ring-offset-ink-deep"
    >
      {children}
      <Arrow />
    </button>
  )
}

function SecondaryButton({
  children,
  onClick,
}: {
  children: React.ReactNode
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 border border-ink-line bg-transparent hover:bg-ink-card text-text-pri font-semibold px-7 py-3.5 text-sm uppercase tracking-wider transition-colors focus:outline-none focus:ring-2 focus:ring-accent-soft focus:ring-offset-2 focus:ring-offset-ink-deep"
    >
      {children}
    </button>
  )
}

function ReviewBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-accent">
        {label}
      </span>
      <dl className="mt-3 space-y-2">{children}</dl>
    </div>
  )
}

function ReviewRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-ink-line/60 py-2">
      <dt className="text-sm text-text-dim">{k}</dt>
      <dd className="text-sm font-medium text-text-pri text-right">{v || '—'}</dd>
    </div>
  )
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
