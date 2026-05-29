'use client'

// /admin — Admin command-centre landing.
//
// Every admin destination in QuoteMate hangs off this page. Tiles
// link to the Bulk Loader (CSV + trade-book extraction), the three
// Quality Agents (Eval / Catalogue / Tradie-Learn), and the
// operator dashboard.
//
// All destinations are server-gated; this page is intentionally
// public-ish — it just renders nav and a "you are signed in as
// admin" badge when /api/admin/whoami confirms it.
//
// Design system: Maintain Technology (dark navy command-centre,
// orange accent, all-caps display, generous spacing, numbered
// cards). See .claude/skills/maintain-design-system.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { getBrowserSupabase } from '@/lib/supabase/client'
import { RoofingActivation } from './_components/RoofingActivation'

type WhoAmI = {
  ok: boolean
  is_admin?: boolean
  user_id?: string
  error?: string
}

type Tile = {
  num: string
  eyebrow: string
  title: string
  blurb: string
  cta: string
  href: string
  external?: boolean
}

const PRIMARY_TILES: Tile[] = [
  {
    num: '01',
    eyebrow: 'Catalogue intake',
    title: 'Bulk loader',
    blurb:
      'Upload a Services / Materials CSV or extract one directly from a trade-book PDF. Stage rows, eyeball the diff, approve to commit or roll back in one click.',
    cta: 'Open the loader',
    href: '/admin/loader',
  },
  {
    num: '02',
    eyebrow: 'Quality agents',
    title: 'Agents overview',
    blurb:
      'Three offline agents measure, audit, and learn from the live pipeline — Eval (rubric scoring), Catalogue QA (drift detection), and Tradie-Learn (edit-pattern clustering). Findings land here for review.',
    cta: 'Open agents',
    href: '/admin/agents',
  },
]

const SECONDARY_TILES: Tile[] = [
  {
    num: '03',
    eyebrow: 'Scoreboard',
    title: 'Eval runs',
    blurb:
      'Rubric-scored hold-out fixture runs against the live estimator. Track per-prompt-version deltas, drill into individual line scores.',
    cta: 'Open eval',
    href: '/admin/agents/eval',
  },
  {
    num: '04',
    eyebrow: 'Catalogue QA',
    title: 'Pending findings',
    blurb:
      'Catalogue rows the QA agent flagged for review — price drift, contradictory descriptions, category mismatches. Approve to clear, dismiss to mute.',
    cta: 'Open queue',
    href: '/admin/agents/catalogue',
  },
  {
    num: '05',
    eyebrow: 'Tradie-Learn',
    title: 'Edit patterns',
    blurb:
      'Clusters of tradie corrections on past quotes — median labour bumps, recurring material swaps, repeated assumption rewrites. Promote a pattern to a catalogue change.',
    cta: 'Open patterns',
    href: '/admin/agents/tradie-edits',
  },
  {
    num: '06',
    eyebrow: 'Operator view',
    title: 'Tradie dashboard',
    blurb:
      'The same CRM the tenant sees — overview, KPIs, pipeline, quote list, SMS conversations, services editor. Useful for spot-checking a live tenant.',
    cta: 'Open dashboard',
    href: '/dashboard',
  },
]

export default function AdminHomePage() {
  const [who, setWho] = useState<WhoAmI | null>(null)
  const [authState, setAuthState] = useState<'loading' | 'signed-out' | 'ready'>(
    'loading',
  )

  useEffect(() => {
    const sb = getBrowserSupabase()
    sb.auth.getSession().then(async ({ data: { session } }) => {
      const t = session?.access_token
      if (!t) {
        setAuthState('signed-out')
        return
      }
      try {
        const res = await fetch('/api/admin/whoami', {
          headers: { Authorization: `Bearer ${t}` },
          cache: 'no-store',
        })
        const json = (await res.json()) as WhoAmI
        setWho(json)
      } catch {
        setWho({ ok: false, error: 'network error' })
      } finally {
        setAuthState('ready')
      }
    })
  }, [])

  return (
    <main className="min-h-screen bg-ink-deep text-text-pri">
      <TopographicBackdrop />

      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section className="relative z-10 mx-auto max-w-7xl px-6 pt-16 pb-12 sm:px-10 md:pt-24 md:pb-16">
        <div className="flex items-center gap-3 font-mono text-[0.75rem] font-semibold uppercase tracking-[0.18em] text-text-dim">
          <span>QuoteMate</span>
          <span className="text-ink-line">/</span>
          <span className="text-text-pri">Admin</span>
        </div>

        <div className="mt-8 grid gap-10 md:grid-cols-[1.6fr_1fr] md:items-end md:gap-16">
          <h1 className="font-extrabold uppercase leading-[0.95] tracking-[-0.035em] text-[clamp(2.75rem,6vw,5.25rem)]">
            The <span className="text-accent">command</span> centre <br className="hidden md:block" />
            for the quote engine.
          </h1>
          <p className="max-w-md text-base leading-relaxed text-text-sec md:text-lg">
            Every back-office surface for QuoteMate lives here — pricing
            catalogue, evaluation runs, agent findings, tenant tools.
            Pick a destination below.
          </p>
        </div>

        <AdminBadge authState={authState} who={who} />
      </section>

      {/* ── Primary destinations ─────────────────────────────────── */}
      <section className="relative z-10 mx-auto max-w-7xl px-6 pb-8 sm:px-10">
        <SectionHeading eyebrow="Primary destinations" title="Where the work happens" />
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {PRIMARY_TILES.map((t) => (
            <DestinationTile key={t.href} tile={t} prominent />
          ))}
        </div>
      </section>

      {/* ── Secondary destinations ───────────────────────────────── */}
      <section className="relative z-10 mx-auto max-w-7xl px-6 pb-12 pt-12 sm:px-10">
        <SectionHeading eyebrow="Agent surfaces & operator view" title="Drill in further" />
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {SECONDARY_TILES.map((t) => (
            <DestinationTile key={t.href} tile={t} />
          ))}
        </div>
      </section>

      {/* ── Roofing activation panel ──────────────────────────────── */}
      <RoofingActivation />

      {/* ── Closing accent bar ───────────────────────────────────── */}
      <div className="relative z-10 bg-accent px-6 py-5 text-center text-white">
        <span className="font-mono text-sm font-semibold uppercase tracking-[0.16em]">
          QuoteMate Admin · v1
        </span>
      </div>
    </main>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <div className="font-mono text-[0.8rem] font-semibold uppercase tracking-[0.18em] text-accent">
        {eyebrow}
      </div>
      <h2 className="mt-3 font-extrabold uppercase tracking-[-0.025em] text-[clamp(1.5rem,2.6vw,2.25rem)] leading-[1.1]">
        {title}
      </h2>
    </div>
  )
}

function DestinationTile({ tile, prominent = false }: { tile: Tile; prominent?: boolean }) {
  return (
    <Link
      href={tile.href}
      className={`group relative block border bg-ink-card p-7 transition-colors hover:border-accent sm:p-9 ${
        prominent ? 'border-ink-line' : 'border-ink-line'
      }`}
    >
      <div className="flex items-start gap-6">
        <span
          className={`font-mono font-bold leading-none text-accent ${
            prominent ? 'text-5xl sm:text-6xl' : 'text-4xl sm:text-5xl'
          }`}
        >
          {tile.num}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-text-dim">
            {tile.eyebrow}
          </div>
          <h3
            className={`mt-2 font-extrabold uppercase tracking-[-0.02em] text-text-pri ${
              prominent ? 'text-2xl sm:text-[1.75rem]' : 'text-xl sm:text-2xl'
            }`}
          >
            {tile.title}
          </h3>
          <p className="mt-4 text-base leading-relaxed text-text-sec">
            {tile.blurb}
          </p>
          <div className="mt-6 inline-flex items-center gap-2 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-accent transition-transform group-hover:translate-x-1">
            {tile.cta}
            <span aria-hidden="true">&rarr;</span>
          </div>
        </div>
      </div>
    </Link>
  )
}

function AdminBadge({
  authState,
  who,
}: {
  authState: 'loading' | 'signed-out' | 'ready'
  who: WhoAmI | null
}) {
  let label = ''
  let tone: 'neutral' | 'good' | 'warn' = 'neutral'
  if (authState === 'loading') {
    label = 'Checking admin status…'
  } else if (authState === 'signed-out') {
    label = 'Not signed in — sign in to use admin actions'
    tone = 'warn'
  } else if (who?.is_admin === true) {
    label = 'Signed in as admin — server actions enabled'
    tone = 'good'
  } else if (who?.ok === true && who.is_admin === false) {
    label = 'Signed in, but not an admin — server actions will 403'
    tone = 'warn'
  } else {
    label = who?.error ? `Auth check failed: ${who.error}` : 'Auth check failed'
    tone = 'warn'
  }

  const dot =
    tone === 'good'
      ? 'bg-teal-glow'
      : tone === 'warn'
        ? 'bg-accent'
        : 'bg-text-dim'

  return (
    <div className="mt-12 inline-flex items-center gap-3 border border-ink-line bg-ink-card px-5 py-3">
      <span className={`h-2.5 w-2.5 ${dot}`} aria-hidden="true" />
      <span className="font-mono text-sm font-semibold uppercase tracking-[0.14em] text-text-sec">
        {label}
      </span>
    </div>
  )
}

function TopographicBackdrop() {
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.18]"
      viewBox="0 0 1920 1080"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="topo-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#14B8A6" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#14B8A6" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke="url(#topo-fade)" strokeWidth="1" fill="none">
        <path d="M0,820 Q220,700 460,760 T940,720 T1420,760 T1920,700" />
        <path d="M0,760 Q220,640 460,700 T940,660 T1420,700 T1920,640" />
        <path d="M0,700 Q220,580 460,640 T940,600 T1420,640 T1920,580" />
        <path d="M0,640 Q220,520 460,580 T940,540 T1420,580 T1920,520" />
        <path d="M0,580 Q220,460 460,520 T940,480 T1420,520 T1920,460" />
        <path d="M0,520 Q220,400 460,460 T940,420 T1420,460 T1920,400" />
        <path d="M0,460 Q220,340 460,400 T940,360 T1420,400 T1920,340" />
        <path d="M0,400 Q220,280 460,340 T940,300 T1420,340 T1920,280" />
      </g>
    </svg>
  )
}
