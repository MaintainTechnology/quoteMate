// QuoteMate home — Maintain design system: dark navy canvas, orange
// accent, all-caps display, signature numbered cards, restraint over decoration.

import Link from "next/link"
import AuthNav from "./AuthNav"

export const metadata = {
  title: "QuoteMate — AI receptionist for Australian tradies",
  description:
    "Customer texts. AI drafts a Good / Better / Best quote. You review, send. For sparkies and plumbers who'd rather be on the tools.",
}

export default function Home() {
  return (
    <>
      {/* ═══════════════ NAV ═══════════════ */}
      <Nav />

      {/* ═══════════════ HERO ═══════════════ */}
      <section className="relative overflow-hidden border-b border-ink-line">
        <Topography />
        <div className="relative z-10 mx-auto max-w-7xl px-6 py-24 md:py-32 grid md:grid-cols-[2fr_1fr] gap-12">
          <div>
            <Eyebrow>AI receptionist · AU tradies · v5 live</Eyebrow>
            <h1 className="mt-6 font-extrabold uppercase text-[clamp(2.75rem,7vw,6rem)] leading-[0.95] tracking-[-0.04em]">
              Drafts your <span className="text-accent">quote</span>
              <br />
              before they <span className="text-accent">hang up.</span>
            </h1>
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <AuthNav variant="hero" />
              <SecondaryCTA href="/docs/tradie-onboarding-plan">See how it works</SecondaryCTA>
            </div>
            <p className="mt-6 text-xs font-mono uppercase tracking-[0.12em] text-text-dim">
              ~3 min to sign up · No credit card · Test phase open
            </p>
          </div>
          <aside className="text-text-sec text-base leading-relaxed self-end">
            <p>
              Customer texts your QuoteMate number. AI asks the right questions.
              A clean Good / Better / Best quote lands in your inbox in under a
              minute. You review, tweak, send.
            </p>
            <p className="mt-4">
              Built for sparkies (NSW) and plumbers (QLD). Each tradie gets their
              own number, pricing book, and AI brand voice.
            </p>
          </aside>
        </div>
      </section>

      {/* ═══════════════ HOW IT WORKS (numbered cards) ═══════════════ */}
      <section id="how" className="border-b border-ink-line">
        <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
          <div className="max-w-3xl">
            <Eyebrow>How it works</Eyebrow>
            <h2 className="mt-3 font-extrabold uppercase text-[clamp(2rem,4vw,3.25rem)] leading-[1] tracking-[-0.035em]">
              Three steps. <span className="text-accent">No phone calls answered at 11pm.</span>
            </h2>
          </div>

          <div className="mt-14 grid gap-4">
            <NumberedCard
              num="01"
              title="Customer texts your number"
              body="Each tradie gets a dedicated AU number. Voice or SMS — both paths feed the same AI receptionist."
            />
            <NumberedCard
              num="02"
              title="AI drafts your quote"
              body="Claude asks the right questions for the job type, applies your pricing book, and writes Good / Better / Best line items in under a minute."
            />
            <NumberedCard
              num="03"
              title="You review, send, get paid"
              body="Quote lands in your inbox. Approve as-is or tweak. Customer pays deposit via Stripe. Site visit booked or job scheduled."
            />
          </div>
        </div>
      </section>

      {/* ═══════════════ TRADES + SCOPE ═══════════════ */}
      <section id="scope" className="border-b border-ink-line">
        <div className="mx-auto max-w-7xl px-6 py-24 md:py-32 grid md:grid-cols-2 gap-10">
          <TradePanel
            label="Electrical"
            state="NSW · NECA pilot"
            auto={[
              "Downlights",
              "Power points (GPOs)",
              "Ceiling fans",
              "Smoke alarms",
              "Outdoor lighting",
            ]}
            inspection={[
              "Switchboard",
              "EV charger",
              "Fault finding",
              "Oven / cooktop",
              "Renovation",
            ]}
          />
          <TradePanel
            label="Plumbing"
            state="QLD · QBCC pilot"
            auto={[
              "Blocked drains",
              "Hot water replace",
              "Tap repair",
              "Tap replace",
              "Toilet repair",
              "Toilet replace",
            ]}
            inspection={[
              "Gas fitting",
              "Burst pipe",
              "Bathroom renovation",
            ]}
          />
        </div>
      </section>

      {/* ═══════════════ NUMBERS ═══════════════ */}
      <section className="border-b border-ink-line">
        <div className="mx-auto max-w-7xl px-6 py-20 grid grid-cols-2 md:grid-cols-4 gap-10">
          <Stat value="< 1 min" label="Per quote drafted" />
          <Stat value="2" label="Trades live" />
          <Stat value="3" label="Pricing tiers" />
          <Stat value="0" label="Auto-sends without you" />
        </div>
      </section>

      {/* ═══════════════ STATUS / TRUST ═══════════════ */}
      <section className="border-b border-ink-line">
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-28">
          <Eyebrow>Where we are</Eyebrow>
          <h2 className="mt-3 font-extrabold uppercase text-[clamp(1.75rem,3.5vw,2.75rem)] leading-[1.05] tracking-[-0.03em]">
            <span className="text-accent">v5 multi-trade</span> shipped.
            <br />
            v6 self-serve onboarding is now.
          </h2>
          <p className="mt-6 text-text-sec text-lg leading-relaxed max-w-2xl">
            Both pilots are running on the same platform. Each tradie has their
            own pricing book, prompt, and AI receptionist. Your turn is next.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <PrimaryCTA href="/signup">Get my QuoteMate</PrimaryCTA>
            <SecondaryCTA href="/docs/tradie-onboarding-plan">See the plan</SecondaryCTA>
          </div>
        </div>
      </section>

      {/* ═══════════════ ORANGE CTA BAR (signature) ═══════════════ */}
      <div className="bg-accent text-white text-center py-5 px-6">
        <span className="font-mono text-sm md:text-base uppercase tracking-[0.16em] font-semibold">
          QuoteMate · Built in Australia · For tradies, by tradies
        </span>
      </div>
    </>
  )
}

/* ─── Primitives ──────────────────────────────────────────────── */

function Nav() {
  return (
    <nav className="sticky top-0 z-50 border-b border-ink-line bg-ink-deep/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center bg-accent font-black text-white text-xs">
            Q
          </span>
          <span className="font-extrabold uppercase tracking-tight text-text-pri">
            QuoteMate
          </span>
        </Link>
        <div className="hidden gap-8 text-sm font-medium text-text-sec md:flex">
          <a href="#how" className="hover:text-text-pri transition-colors">How</a>
          <a href="#scope" className="hover:text-text-pri transition-colors">Scope</a>
          <Link href="/docs/tradie-onboarding-plan" className="hover:text-text-pri transition-colors">Plan</Link>
        </div>
        <div className="flex items-center gap-2 md:gap-3">
          <AuthNav variant="nav" />
        </div>
      </div>
    </nav>
  )
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-xs uppercase tracking-[0.18em] text-text-dim font-semibold">
      {children}
    </span>
  )
}

function PrimaryCTA({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-7 py-3.5 text-sm uppercase tracking-wider transition-colors focus:outline-none focus:ring-2 focus:ring-accent-soft focus:ring-offset-2 focus:ring-offset-ink-deep"
    >
      {children}
      <Arrow />
    </Link>
  )
}

function SecondaryCTA({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 border border-ink-line bg-transparent hover:bg-ink-card text-text-pri font-semibold px-7 py-3.5 text-sm uppercase tracking-wider transition-colors focus:outline-none focus:ring-2 focus:ring-accent-soft focus:ring-offset-2 focus:ring-offset-ink-deep"
    >
      {children}
    </Link>
  )
}

function NumberedCard({ num, title, body }: { num: string; title: string; body: string }) {
  return (
    <article className="bg-ink-card border border-ink-line p-6 md:p-10">
      <div className="flex items-start gap-6 md:gap-10">
        <span className="font-mono text-5xl md:text-7xl font-bold text-accent leading-none shrink-0">
          {num}
        </span>
        <div>
          <h3 className="text-text-pri font-extrabold text-xl md:text-2xl uppercase tracking-tight">
            {title}
          </h3>
          <p className="mt-3 text-text-sec text-base md:text-lg leading-relaxed max-w-2xl">
            {body}
          </p>
        </div>
      </div>
    </article>
  )
}

function TradePanel({
  label,
  state,
  auto,
  inspection,
}: {
  label: string
  state: string
  auto: string[]
  inspection: string[]
}) {
  return (
    <div className="bg-ink-card border border-ink-line p-6 md:p-8">
      <div className="flex items-baseline justify-between">
        <h3 className="font-extrabold uppercase text-2xl md:text-3xl tracking-tight">
          {label}
        </h3>
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim">
          {state}
        </span>
      </div>

      <div className="mt-8">
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-accent">
          Auto-quoted
        </span>
        <ul className="mt-3 grid gap-2">
          {auto.map((it) => (
            <li key={it} className="flex items-baseline gap-3 text-text-sec text-sm md:text-base">
              <span className="text-accent font-mono text-xs">→</span>
              {it}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-7">
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-text-dim">
          $99 site visit
        </span>
        <ul className="mt-3 grid gap-2">
          {inspection.map((it) => (
            <li key={it} className="flex items-baseline gap-3 text-text-dim text-sm md:text-base">
              <span className="text-text-dim font-mono text-xs">○</span>
              {it}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="font-mono font-bold text-accent text-[clamp(2.5rem,5vw,4.25rem)] leading-none tracking-tight">
        {value}
      </div>
      <div className="mt-3 text-xs uppercase tracking-[0.16em] text-text-dim font-mono font-semibold">
        {label}
      </div>
    </div>
  )
}

function Arrow() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  )
}

function Topography() {
  return (
    <svg
      className="absolute inset-0 w-full h-full opacity-[0.22] pointer-events-none"
      viewBox="0 0 1920 1080"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <g fill="none" stroke="var(--teal-glow)" strokeWidth="1">
        <path d="M0,820 Q240,700 480,760 T960,720 T1440,780 T1920,740" />
        <path d="M0,870 Q240,760 480,800 T960,780 T1440,830 T1920,800" opacity="0.7" />
        <path d="M0,920 Q240,820 480,850 T960,830 T1440,880 T1920,850" opacity="0.5" />
        <path d="M0,970 Q240,880 480,900 T960,880 T1440,930 T1920,900" opacity="0.35" />
        <path d="M0,1020 Q240,940 480,960 T960,940 T1440,980 T1920,960" opacity="0.2" />
      </g>
    </svg>
  )
}
