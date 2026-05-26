// WP9 — customer product-choice page.
// Reached via the SMS "See photos: {APP_URL}/q/choose/{token}".
// Same trust model as /upload/[token] — the token is unguessable.
// Shows the operator's TWO real products (Good / Better) with photos +
// prices; the customer taps one and it's recorded against the
// conversation (drives both the quote price and the WP4 render).

import { createClient } from '@supabase/supabase-js'
import Link from 'next/link'
import type { ProductChoiceState } from '@/lib/sms/product-options'
import { ChoiceCards } from './ChoiceCards'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export default async function ChoosePage(props: {
  params: Promise<{ token: string }>
}) {
  const { token } = await props.params

  const { data } = await supabase
    .from('sms_conversations')
    .select('product_choice')
    .eq('product_choice->>token', token)
    .maybeSingle()

  const choice = (data?.product_choice ?? null) as ProductChoiceState | null

  return (
    <main className="min-h-screen bg-ink-deep text-text-pri">
      <header className="border-b border-ink-line bg-ink-deep/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="font-extrabold uppercase tracking-tight text-accent">
            QuoteMate
          </Link>
          <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-text-dim">
            Choose your product
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        {!choice || !Array.isArray(choice.options) || choice.options.length === 0 ? (
          <section className="bg-ink-card border-2 border-warning/50 p-8">
            <div className="font-mono text-[0.7rem] uppercase tracking-[0.15em] text-warning mb-3">
              Link not found
            </div>
            <p className="text-text-sec">
              This link is invalid or has expired. Reply to your QuoteMate SMS
              if you need a fresh one.
            </p>
          </section>
        ) : (
          <>
            <h1 className="font-extrabold uppercase tracking-[-0.03em] text-[clamp(1.5rem,4.5vw,2.5rem)] leading-none">
              {choice.options.length === 1 ? 'Confirm your' : 'Pick your'}{' '}
              <span className="text-accent">
                {(choice.category || 'product').replace(/_/g, ' ')}
              </span>
            </h1>
            <p className="mt-4 max-w-xl text-text-sec">
              {choice.options.length === 1
                ? "The product your tradie stocks for this job. Tap to confirm — it goes straight into your quote and your preview."
                : "Two real options your tradie installs. Tap the one you'd like — it goes straight into your quote and your preview."}
            </p>
            <div className="mt-8">
              <ChoiceCards
                token={token}
                initialStatus={choice.status}
                initialChosenId={choice.chosen_catalogue_id ?? null}
                options={choice.options.slice(0, 2).map((o) => ({
                  catalogue_id: o.catalogue_id,
                  name: o.name,
                  brand: o.brand ?? null,
                  range_series: o.range_series ?? null,
                  price_ex_gst: o.price_ex_gst,
                  image_path: o.image_path ?? null,
                  description: o.description ?? null,
                  tier: o.tier,
                }))}
              />
            </div>
          </>
        )}

        <p className="mt-12 text-center font-mono text-[0.65rem] uppercase tracking-[0.2em] text-text-dim">
          Powered by{' '}
          <Link href="/" className="text-text-sec hover:text-accent transition-colors">
            QuoteMate
          </Link>{' '}
          · Built in Australia
        </p>
      </div>
    </main>
  )
}
