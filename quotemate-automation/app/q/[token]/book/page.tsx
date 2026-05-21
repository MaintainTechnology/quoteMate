// Customer-facing booking page — Maintain Technology design system
// (dark navy canvas, vibrant orange, JetBrains Mono eyebrows, ALL-CAPS
// display, topographic overlay, square edges, borders not shadows).
// Visual language matches /q/[token]. Logic is unchanged.
//
// WP6 reorder: BOOK FIRST, PAY LAST. The customer lands here from the
// quote (the pay short-link routes here when no slot is chosen yet).
// They pick a time → it's reserved on the quote → they're sent to the
// deposit step → paying CONFIRMS the booking (Stripe webhook).
//
// States (each renders without breaking):
//   1. token not found                    → 404
//   2. paid + scheduled                    → "Booked" (confirmed)
//   3. not paid + slot already chosen      → "Time held — pay deposit"
//   4. not paid + no slot + slots open     → SlotPicker (pick first)
//   5. not paid + no slot + NO slots open  → pay now, tradie arranges time
//   6. paid + no slot (legacy/no slots)    → pick a time / we'll be in touch

import type { ReactNode } from 'react'
import { createClient } from '@supabase/supabase-js'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { resolveGoogleBookingUrl } from '@/lib/quote/booking'
import { SlotPicker } from './SlotPicker'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const PAY_TIERS = new Set(['good', 'better', 'best'])

function formatSlot(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-AU', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Australia/Sydney',
    })
  } catch {
    return iso
  }
}

// Signature Maintain motif — low-opacity topographic ridge lines, teal
// stroke, behind everything. Pure decoration, pointer-events-none.
function Topo() {
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.12]"
      viewBox="0 0 1920 1080"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {[0, 70, 140, 210, 280, 350, 420].map((dy) => (
        <path
          key={dy}
          d={`M0,${760 - dy} Q240,${600 - dy} 480,${690 - dy} T960,${
            640 - dy
          } T1440,${700 - dy} T1920,${610 - dy}`}
          stroke="var(--color-teal-glow, #14B8A6)"
          strokeWidth="1"
          fill="none"
        />
      ))}
    </svg>
  )
}

// 3-step ops strip — makes the new book → pay → confirmed order legible
// at a glance. `active` highlights the current step in orange; earlier
// steps read as done.
function StepStrip({ active }: { active: 1 | 2 | 3 }) {
  const steps = [
    { n: '01', label: 'Choose a time' },
    { n: '02', label: 'Pay deposit' },
    { n: '03', label: 'Confirmed' },
  ]
  return (
    <div className="mb-6 flex flex-wrap gap-x-6 gap-y-2 border-b border-ink-line pb-4">
      {steps.map((s, i) => {
        const step = i + 1
        const isActive = step === active
        const isDone = step < active
        return (
          <span
            key={s.n}
            className={`font-mono text-[0.7rem] uppercase tracking-[0.16em] ${
              isActive
                ? 'text-accent'
                : isDone
                  ? 'text-text-sec'
                  : 'text-text-dim'
            }`}
          >
            <span className="font-bold">{s.n}</span>
            {isDone ? ' ✓ ' : ' · '}
            {s.label}
          </span>
        )
      })}
    </div>
  )
}

export default async function BookingPage(props: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ tier?: string }>
}) {
  const { token } = await props.params
  const sp = await props.searchParams

  const { data: quote } = await supabase
    .from('quotes')
    .select('id, paid_at, paid_tier, selected_tier, scheduled_at, share_token, intake_id')
    .eq('share_token', token)
    .maybeSingle()

  if (!quote) notFound()

  // v8 — realised early-booking discount, for the "time held" copy.
  // Separate best-effort select (column lands via migration 044).
  let appliedDiscountPct = 0
  {
    const { data: eb } = await supabase
      .from('quotes')
      .select('applied_discount_pct')
      .eq('id', quote.id)
      .maybeSingle()
    if (eb) appliedDiscountPct = Number(eb.applied_discount_pct ?? 0)
  }

  // Single-tradie v0.5 model — when tradie #2 onboards, key on intake.tradie_id.
  const { data: tradie } = await supabase
    .from('tradies')
    .select('id, business_name, available_slots')
    .limit(1)
    .maybeSingle()

  const slots: string[] = Array.isArray(tradie?.available_slots)
    ? (tradie!.available_slots as string[])
    : []

  const isPaid = !!quote.paid_at
  const isScheduled = !!quote.scheduled_at

  // Tier to charge at the deposit step: query param (carried from the
  // quote page tier button) → the quote's selected_tier → 'better'.
  const tier =
    sp.tier && PAY_TIERS.has(sp.tier)
      ? sp.tier
      : PAY_TIERS.has(String(quote.selected_tier))
        ? String(quote.selected_tier)
        : 'better'

  // Off-platform "book directly on the tradie's calendar" link (Google
  // Appointment). Decision: DB picker = pay-last + auto-confirmed;
  // Google = off-platform, tradie handles that deposit. Null when unset
  // or not a valid https URL → the option simply doesn't render.
  const googleUrl = resolveGoogleBookingUrl(process.env.GOOGLE_BOOKING_URL)
  const tradieName = tradie?.business_name ?? null

  let content: ReactNode
  if (isPaid && isScheduled) {
    content = (
      <AlreadyScheduledState
        scheduledAt={quote.scheduled_at!}
        tradieName={tradieName}
      />
    )
  } else if (!isPaid && isScheduled) {
    content = (
      <ReservedPayState
        token={token}
        tier={tier}
        scheduledAt={quote.scheduled_at!}
        appliedDiscountPct={appliedDiscountPct}
      />
    )
  } else if (!isPaid && !isScheduled && slots.length > 0) {
    content = (
      <PickState
        token={token}
        slots={slots}
        tier={tier}
        tradieName={tradieName}
        googleUrl={googleUrl}
      />
    )
  } else if (!isPaid && !isScheduled && slots.length === 0) {
    content = (
      <NoSlotsPayState
        token={token}
        tier={tier}
        tradieName={tradieName}
        googleUrl={googleUrl}
      />
    )
  } else if (isPaid && !isScheduled && slots.length > 0) {
    // Legacy: paid before this reorder shipped, now needs to pick a time.
    content = (
      <PickState
        token={token}
        slots={slots}
        tier={tier}
        tradieName={tradieName}
        googleUrl={googleUrl}
      />
    )
  } else {
    content = (
      <NoSlotsState tradieName={tradieName} googleUrl={googleUrl} />
    )
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-ink-deep text-text-pri">
      <Topo />

      <header className="relative z-10 border-b border-ink-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-5 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center bg-accent text-sm font-black text-white">
              Q
            </span>
            <span className="font-extrabold uppercase tracking-tight">
              QuoteMate
            </span>
          </Link>
          <Link
            href={`/q/${token}`}
            className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-text-dim transition-colors hover:text-accent"
          >
            ← Back to quote
          </Link>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-5xl px-5 py-7 sm:px-6 sm:py-9">
        {content}
      </div>

      <div className="relative z-10 bg-accent px-6 py-4 text-center">
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-white">
          QuoteMate · Book · Pay · Done
        </span>
      </div>
    </main>
  )
}

function AlreadyScheduledState({
  scheduledAt,
  tradieName,
}: {
  scheduledAt: string
  tradieName: string | null
}) {
  return (
    <section className="motion-safe:animate-[fade-in_240ms_ease-out_both]">
      <StepStrip active={3} />
      <span className="inline-flex items-center bg-teal-glow/15 px-3 py-1 font-mono text-[0.7rem] font-bold uppercase tracking-[0.16em] text-teal-glow">
        Booked · Confirmed
      </span>
      <h1 className="mt-6 text-[clamp(2rem,5vw,3.25rem)] font-extrabold uppercase leading-[1.02] tracking-[-0.03em]">
        You&apos;re <span className="text-accent">locked in</span> for{' '}
        {formatSlot(scheduledAt)}.
      </h1>
      <p className="mt-5 max-w-[60ch] text-base leading-relaxed text-text-sec">
        Deposit received and your time is confirmed.{' '}
        {tradieName ? `${tradieName} will` : 'Your tradie will'} confirm by SMS
        the day before. If anything changes, reply to that SMS and they&apos;ll
        reschedule.
      </p>
    </section>
  )
}

// A time is chosen but the deposit (the LAST step) isn't paid yet.
function ReservedPayState({
  token,
  tier,
  scheduledAt,
  appliedDiscountPct,
}: {
  token: string
  tier: string
  scheduledAt: string
  /** v8 — realised early-booking discount %. 0 = none. */
  appliedDiscountPct: number
}) {
  const discounted = appliedDiscountPct > 0
  return (
    <section className="motion-safe:animate-[fade-in_240ms_ease-out_both]">
      <StepStrip active={2} />
      <span className="inline-flex items-center bg-accent/15 px-3 py-1 font-mono text-[0.7rem] font-bold uppercase tracking-[0.16em] text-accent">
        Time held
      </span>
      <h1 className="mt-6 text-[clamp(2rem,5vw,3.25rem)] font-extrabold uppercase leading-[1.02] tracking-[-0.03em]">
        {formatSlot(scheduledAt)} is <span className="text-accent">held</span>{' '}
        for you.
      </h1>
      {discounted ? (
        <p className="mt-5 inline-flex items-center bg-teal-glow/15 px-3 py-1.5 font-mono text-[0.7rem] font-bold uppercase tracking-[0.14em] text-teal-glow">
          {appliedDiscountPct}% early-booking discount applied
        </p>
      ) : null}
      <p className="mt-5 max-w-[60ch] text-base leading-relaxed text-text-sec">
        One last step — pay your deposit to lock it in. Your time isn&apos;t
        confirmed until the deposit is paid.
        {discounted
          ? ' Your discounted deposit is shown at checkout.'
          : ''}
      </p>
      <a
        href={`/r/${token}/${tier}`}
        className="mt-8 inline-flex items-center gap-2 bg-accent px-6 py-3.5 text-sm font-semibold uppercase tracking-wider text-white transition-colors hover:bg-accent-press"
      >
        Pay deposit &amp; confirm →
      </a>
      <p className="mt-5 font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim">
        Picked the wrong time?{' '}
        <Link
          href={`/q/${token}/book`}
          className="text-text-sec underline underline-offset-4 hover:text-accent"
        >
          Choose another
        </Link>
      </p>
    </section>
  )
}

// Off-platform alternative: book straight into the tradie's own Google
// calendar. Renders nothing unless a valid https link is configured.
// Copy is explicit that this path is arranged with the tradie directly
// (no QuoteMate deposit/confirmation on it) so the customer isn't
// surprised — matches the "DB = pay-last; Google = off-platform" call.
function GoogleBookingOption({
  googleUrl,
  tradieName,
}: {
  googleUrl: string | null
  tradieName: string | null
}) {
  if (!googleUrl) return null
  const who = tradieName ?? 'the tradie'
  return (
    <div className="mt-6 border-t border-ink-line pt-5">
      <span className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-text-dim">
        Or book direct
      </span>
      <p className="mt-2 text-sm font-semibold text-text-pri">
        Prefer to book straight into {who}&apos;s calendar?
      </p>
      <p className="mt-1 max-w-[58ch] text-xs leading-relaxed text-text-sec">
        Opens {who}&apos;s Google booking page. With this option your deposit is
        sorted with {who} directly — it won&apos;t go through the screen above.
      </p>
      <a
        href={googleUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex items-center gap-2 border border-ink-line px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-text-pri transition-colors hover:border-accent hover:text-accent"
      >
        Book on {who}&apos;s calendar ↗
      </a>
    </div>
  )
}

function NoSlotsState({
  tradieName,
  googleUrl,
}: {
  tradieName: string | null
  googleUrl: string | null
}) {
  return (
    <section className="motion-safe:animate-[fade-in_240ms_ease-out_both]">
      <StepStrip active={1} />
      <span className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-text-dim">
        Scheduling
      </span>
      <h1 className="mt-6 text-[clamp(2rem,5vw,3.25rem)] font-extrabold uppercase leading-[1.02] tracking-[-0.03em]">
        We&apos;ll be <span className="text-accent">in touch</span>
      </h1>
      <p className="mt-5 max-w-[60ch] text-base leading-relaxed text-text-sec">
        {tradieName ?? 'Your tradie'} doesn&apos;t have published times right
        now. They&apos;ll text you within one business day to arrange one.
      </p>
      <GoogleBookingOption googleUrl={googleUrl} tradieName={tradieName} />
    </section>
  )
}

// No slots published yet, and not paid: let them pay to hold their place;
// the tradie arranges the time. Keeps the funnel from dead-ending.
function NoSlotsPayState({
  token,
  tier,
  tradieName,
  googleUrl,
}: {
  token: string
  tier: string
  tradieName: string | null
  googleUrl: string | null
}) {
  return (
    <section className="motion-safe:animate-[fade-in_240ms_ease-out_both]">
      <StepStrip active={1} />
      <span className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-text-dim">
        Scheduling
      </span>
      <h1 className="mt-6 text-[clamp(2rem,5vw,3.25rem)] font-extrabold uppercase leading-[1.02] tracking-[-0.03em]">
        No times <span className="text-accent">published</span> yet
      </h1>
      <p className="mt-5 max-w-[60ch] text-base leading-relaxed text-text-sec">
        {tradieName ?? 'Your tradie'} hasn&apos;t put up bookable times yet. You
        can still secure the job with your deposit — they&apos;ll text you to
        lock in a time.
      </p>
      <a
        href={`/r/${token}/${tier}`}
        className="mt-8 inline-flex items-center gap-2 bg-accent px-6 py-3.5 text-sm font-semibold uppercase tracking-wider text-white transition-colors hover:bg-accent-press"
      >
        Pay deposit to secure →
      </a>
      <GoogleBookingOption googleUrl={googleUrl} tradieName={tradieName} />
    </section>
  )
}

function PickState({
  token,
  slots,
  tier,
  tradieName,
  googleUrl,
}: {
  token: string
  slots: string[]
  tier: string
  tradieName: string | null
  googleUrl: string | null
}) {
  return (
    <section className="motion-safe:animate-[fade-in_240ms_ease-out_both]">
      <StepStrip active={1} />
      <span className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-text-dim">
        Step 01 — Choose a time
      </span>
      <h1 className="mt-3 text-[clamp(1.5rem,3.5vw,2.25rem)] font-extrabold uppercase leading-none tracking-[-0.035em]">
        Pick a time that <span className="text-accent">works</span>.
      </h1>
      <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-text-sec">
        {tradieName ? `${tradieName}'s` : "Your tradie's"} next available times —
        pick one, then pay your deposit to lock it in (last step).
      </p>
      <div className="mt-6">
        <SlotPicker token={token} slots={slots} tier={tier} />
      </div>
      <GoogleBookingOption googleUrl={googleUrl} tradieName={tradieName} />
    </section>
  )
}
