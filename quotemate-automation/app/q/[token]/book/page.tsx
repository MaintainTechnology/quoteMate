// Customer-facing booking page.
//
// WP6 reorder: BOOK FIRST, PAY LAST. The customer lands here from the
// quote (the pay short-link now routes here when no slot is chosen yet).
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
    <main className="min-h-screen bg-zinc-50 font-sans text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-zinc-900 text-xs font-black text-white">Q</span>
            <span className="font-bold tracking-tight">QuoteMate</span>
          </Link>
          <Link href={`/q/${token}`} className="text-xs text-zinc-500 underline-offset-2 hover:underline">
            Back to quote
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">{content}</div>
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
    <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-6 sm:p-8">
      <span className="inline-block rounded-md bg-emerald-100 px-3 py-1 text-xs font-bold uppercase tracking-widest text-emerald-700">
        Booked
      </span>
      <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-emerald-950">
        You&apos;re locked in for {formatSlot(scheduledAt)}.
      </h1>
      <p className="mt-3 text-sm text-emerald-900">
        Deposit received and your time is confirmed.{' '}
        {tradieName ? `${tradieName} will` : 'Your tradie will'} confirm by SMS the day before. If anything changes,
        reply to that SMS and they&apos;ll reschedule.
      </p>
    </section>
  )
}

// New: a time is chosen but the deposit (the LAST step) isn't paid yet.
function ReservedPayState({
  token,
  tier,
  scheduledAt,
}: {
  token: string
  tier: string
  scheduledAt: string
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6 sm:p-8">
      <span className="inline-block rounded-md bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-widest text-amber-700">
        Time held
      </span>
      <h1 className="mt-4 text-2xl font-extrabold tracking-tight">
        {formatSlot(scheduledAt)} is held for you.
      </h1>
      <p className="mt-3 text-sm text-zinc-700">
        One last step — pay your deposit to lock it in. Your time isn&apos;t confirmed until the deposit is paid.
      </p>
      <a
        href={`/r/${token}/${tier}`}
        className="mt-5 inline-block rounded-md bg-zinc-900 px-5 py-3 text-sm font-semibold text-white hover:bg-zinc-700"
      >
        Pay deposit &amp; confirm →
      </a>
      <p className="mt-3 text-xs text-zinc-500">
        Picked the wrong time?{' '}
        <Link href={`/q/${token}/book`} className="underline">
          Choose another
        </Link>
        .
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
  return (
    <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 sm:p-5">
      <p className="text-sm font-semibold text-zinc-900">
        Prefer to book straight into {tradieName ?? 'the tradie'}&apos;s calendar?
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        Opens {tradieName ?? 'the tradie'}&apos;s Google booking page. With this option your
        deposit is sorted with {tradieName ?? 'the tradie'} directly — it won&apos;t go through
        the screen above.
      </p>
      <a
        href={googleUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-block rounded-md border border-zinc-300 px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-zinc-50"
      >
        Book on {tradieName ?? 'the tradie'}&apos;s calendar ↗
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
    <section className="rounded-lg border border-zinc-200 bg-white p-6 sm:p-8">
      <h1 className="text-2xl font-extrabold tracking-tight">We&apos;ll be in touch</h1>
      <p className="mt-3 text-sm text-zinc-700">
        {tradieName ?? 'Your tradie'} doesn&apos;t have published times right now. They&apos;ll text you within one
        business day to arrange one.
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
    <section className="rounded-lg border border-zinc-200 bg-white p-6 sm:p-8">
      <h1 className="text-2xl font-extrabold tracking-tight">No times published yet</h1>
      <p className="mt-3 text-sm text-zinc-700">
        {tradieName ?? 'Your tradie'} hasn&apos;t put up bookable times yet. You can still secure the job with your
        deposit — they&apos;ll text you to lock in a time.
      </p>
      <a
        href={`/r/${token}/${tier}`}
        className="mt-5 inline-block rounded-md bg-zinc-900 px-5 py-3 text-sm font-semibold text-white hover:bg-zinc-700"
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
    <section>
      <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Pick a time that works.</h1>
      <p className="mt-3 text-sm text-zinc-600 sm:text-base">
        These are {tradieName ? `${tradieName}'s` : "your tradie's"} next available times. Choose one, then pay your
        deposit to lock it in — that&apos;s the last step.
      </p>
      <div className="mt-8">
        <SlotPicker token={token} slots={slots} tier={tier} />
      </div>
      <GoogleBookingOption googleUrl={googleUrl} tradieName={tradieName} />
    </section>
  )
}
