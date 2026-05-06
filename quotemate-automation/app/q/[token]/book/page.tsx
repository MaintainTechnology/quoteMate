// Customer-facing booking page. Reached after deposit success — the SMS
// thank-you path links here, and (once flipped) the Stripe success_url will
// land directly here. Reads `tradies.available_slots` and lets the customer
// pick one, which a POST to /api/q/[token]/book persists onto the quote.
//
// Defensive states (any of these renders without breaking):
//   1. Quote token not found              → 404
//   2. Quote not yet paid                  → "complete deposit first"
//   3. Quote already scheduled             → show booked time, no picker
//   4. Tradie row missing OR no slots      → "we'll be in touch" fallback
//   5. Otherwise                           → SlotPicker

import { createClient } from '@supabase/supabase-js'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { SlotPicker } from './SlotPicker'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

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
}) {
  const { token } = await props.params

  const { data: quote } = await supabase
    .from('quotes')
    .select('id, paid_at, paid_tier, scheduled_at, share_token, intake_id')
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

      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        {!isPaid ? (
          <NotPaidState token={token} />
        ) : isScheduled ? (
          <AlreadyScheduledState
            scheduledAt={quote.scheduled_at!}
            tradieName={tradie?.business_name ?? null}
          />
        ) : slots.length === 0 ? (
          <NoSlotsState tradieName={tradie?.business_name ?? null} />
        ) : (
          <PickState token={token} slots={slots} tradieName={tradie?.business_name ?? null} />
        )}
      </div>
    </main>
  )
}

function NotPaidState({ token }: { token: string }) {
  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 p-6 sm:p-8">
      <h1 className="text-2xl font-extrabold tracking-tight">Pay your deposit to book</h1>
      <p className="mt-3 text-sm text-amber-900">
        We can't lock in a time until your deposit is paid. Head back to your quote and tap the option you'd like.
      </p>
      <Link
        href={`/q/${token}`}
        className="mt-5 inline-block rounded-md bg-amber-600 px-4 py-3 text-sm font-semibold text-white hover:bg-amber-500"
      >
        Back to quote
      </Link>
    </section>
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
        You're locked in for {formatSlot(scheduledAt)}.
      </h1>
      <p className="mt-3 text-sm text-emerald-900">
        {tradieName ? `${tradieName} will` : 'Your tradie will'} confirm by SMS the day before. If anything changes,
        reply to that SMS and they'll reschedule.
      </p>
    </section>
  )
}

function NoSlotsState({ tradieName }: { tradieName: string | null }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6 sm:p-8">
      <h1 className="text-2xl font-extrabold tracking-tight">Deposit received — we'll be in touch</h1>
      <p className="mt-3 text-sm text-zinc-700">
        {tradieName ?? 'Your tradie'} doesn't have published slots right now. They'll text you within one business
        day to confirm a time.
      </p>
    </section>
  )
}

function PickState({
  token,
  slots,
  tradieName,
}: {
  token: string
  slots: string[]
  tradieName: string | null
}) {
  return (
    <section>
      <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Pick a time that works.</h1>
      <p className="mt-3 text-sm text-zinc-600 sm:text-base">
        These are {tradieName ? `${tradieName}'s` : "your tradie's"} next available slots. Tap one to lock it in —
        you'll get an SMS confirmation right after.
      </p>
      <div className="mt-8">
        <SlotPicker token={token} slots={slots} />
      </div>
    </section>
  )
}
