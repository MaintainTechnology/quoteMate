import Link from "next/link";

export default function Home() {
  return (
    <div className="font-sans flex flex-col flex-1">
      {/* ═══════════════ NAV ═══════════════ */}
      <nav className="sticky top-0 z-50 border-b border-zinc-200 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-zinc-900 text-xs font-black text-white">
              Q
            </span>
            <span className="font-bold tracking-tight text-zinc-900">QuoteMate</span>
          </Link>
          <div className="hidden gap-8 text-sm font-medium text-zinc-600 md:flex">
            <a href="#how-it-works" className="hover:text-zinc-900">How it works</a>
            <a href="#who-its-for" className="hover:text-zinc-900">Who it&apos;s for</a>
            <a href="#features" className="hover:text-zinc-900">Features</a>
            <a href="#scope" className="hover:text-zinc-900">v1 scope</a>
            <a href="#status" className="hover:text-zinc-900">Status</a>
          </div>
          <a
            href="/docs/architecture.html"
            className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-700"
          >
            View architecture
          </a>
        </div>
      </nav>

      {/* ═══════════════ HERO ═══════════════ */}
      <section className="border-b border-zinc-200">
        <div className="mx-auto max-w-4xl px-6 py-24 sm:py-32">
          <span className="inline-block rounded-md border border-zinc-200 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Australian electrical · NSW pilot · v1 wedge
          </span>
          <h1 className="mt-6 text-5xl font-extrabold leading-[1.05] tracking-tight text-zinc-900 sm:text-6xl">
            Quote drafted{" "}
            <em className="not-italic text-blue-600">before they hang up.</em>
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-zinc-600">
            QuoteMate is an AI quoting backend for Australian electricians. A homeowner
            describes their job — typed in a portal or spoken to an AI receptionist — and
            a fully drafted Good / Better / Best quote lands in your inbox in under a
            minute. You review, tweak, send.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="/docs/architecture.html"
              className="rounded-full bg-zinc-900 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-zinc-700"
            >
              View the architecture
            </a>
            <a
              href="/docs/build-guide.html"
              className="rounded-full border border-zinc-300 px-6 py-3 text-sm font-semibold text-zinc-900 transition-colors hover:bg-zinc-50"
            >
              Read the build guide
            </a>
          </div>
          <div className="mt-12 grid grid-cols-2 gap-6 border-t border-zinc-200 pt-8 sm:grid-cols-4">
            <Stat value="< 1 min" label="Quote drafted" />
            <Stat value="9" label="Job types covered" />
            <Stat value="3 tiers" label="Good / Better / Best" />
            <Stat value="0" label="Auto-sends" />
          </div>
        </div>
      </section>

      {/* ═══════════════ WHO IT'S FOR ═══════════════ */}
      <section id="who-its-for" className="border-b border-zinc-200 bg-zinc-50">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <Eyebrow>Who it&apos;s for</Eyebrow>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Built for the tradies actually drowning in quotes.
          </h2>
          <p className="mt-4 max-w-2xl text-zinc-600">
            If you spend two hours every night writing quotes after a 10-hour day on the
            tools, this is for you.
          </p>
          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            <Card
              title="Owner-operator electricians"
              body="One sparky, sometimes a 2-IC. No office manager. Quotes are something you do at 9pm or lose to whoever replied first."
            />
            <Card
              title="NSW-licensed (NECA)"
              body="v1 is built around NSW compliance — licence display, AU pricing bands, Sydney/regional patterns. VIC (ESV) and QLD (QBCC) support is queued for v2."
            />
            <Card
              title="The bread-and-butter jobs"
              body="Downlights, GPOs, ceiling fans, smoke alarms, outdoor lighting. The work that takes 5 minutes onsite but 30 minutes to quote — finally automated."
            />
          </div>
        </div>
      </section>

      {/* ═══════════════ HOW IT WORKS ═══════════════ */}
      <section id="how-it-works" className="border-b border-zinc-200">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <Eyebrow>How it works</Eyebrow>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Five stages from &quot;ring ring&quot; to &quot;draft saved&quot;.
          </h2>
          <p className="mt-4 max-w-2xl text-zinc-600">
            Same five stages whether the customer types into the portal or talks to the
            voice agent — only Stage 03 changes.
          </p>
          <ol className="mt-12 grid gap-4 sm:grid-cols-5">
            <Stage
              num="01"
              title="Customer reaches out"
              body="Types into the portal, or dials your dedicated AU number."
            />
            <Stage
              num="02"
              title="Channel routing"
              body="Vapi answers the call, or the portal accepts the form submission."
              accent="amber"
            />
            <Stage
              num="03"
              title="Structured intake"
              body="The AI asks the right 6–8 questions for the job type. Captures scope, risks, photos."
              accent="orange"
            />
            <Stage
              num="04"
              title="Intake structuring"
              body="Claude Sonnet turns the conversation into clean JSON: job type, scope, access, confidence."
              accent="cyan"
            />
            <Stage
              num="05"
              title="Quote drafting"
              body="Claude Opus calls four pricing tools to draft Good / Better / Best with line items."
              accent="violet"
            />
          </ol>
          <div className="mt-10 rounded-lg border border-zinc-200 bg-zinc-50 p-6 text-sm text-zinc-700">
            <strong className="text-zinc-900">Total time:</strong> ~45 seconds from
            hangup to a draft sitting in the database. The tradie sees it whenever they
            check their dashboard — never gets pinged at 11pm.
          </div>
        </div>
      </section>

      {/* ═══════════════ FEATURES ═══════════════ */}
      <section id="features" className="border-b border-zinc-200 bg-zinc-50">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <Eyebrow>What you get</Eyebrow>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            Functionality, in plain English.
          </h2>
          <div className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            <Feature
              title="24/7 intake"
              body="Portal is always open. Voice agent (v3+) answers every call, including after-hours emergencies."
            />
            <Feature
              title="Photo capture via SMS"
              body="The AI texts the homeowner a link to upload photos of the switchboard, ceiling, or area — needed for an accurate quote."
            />
            <Feature
              title="Three-tier pricing"
              body="Every quote is Good / Better / Best with real line items, not a single take-it-or-leave-it number."
            />
            <Feature
              title="Inspection routing"
              body="Switchboards, EV chargers, fault finding, complex renos — auto-routed to a paid $199 site visit, never auto-quoted."
            />
            <Feature
              title="Per-tradie pricing book"
              body="Your hourly rate, your markup, your call-out minimum. Overlays on top of the shared assembly library."
            />
            <Feature
              title="AU compliance built in"
              body="GST handled correctly (ex-GST stored, inc-GST displayed). Licence number printed on every quote. Recording consent on every voice call."
            />
            <Feature
              title="Risk flagging"
              body="Burning smell, ceramic-fuse switchboard, water damage, pre-1970 property — all surfaced as risks on the quote for tradie review."
            />
            <Feature
              title="Tradie review before send"
              body="No quote auto-sends in v1. You review, tweak, approve. Australian Consumer Law makes this non-negotiable."
            />
            <Feature
              title="Similar-job retrieval"
              body="pgvector finds the 5 most similar past intakes — pricing accuracy improves with every quote you draft."
            />
          </div>
        </div>
      </section>

      {/* ═══════════════ SCOPE ═══════════════ */}
      <section id="scope" className="border-b border-zinc-200">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <Eyebrow>v1 scope</Eyebrow>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            What&apos;s in v1 — and what isn&apos;t, on purpose.
          </h2>
          <p className="mt-4 max-w-2xl text-zinc-600">
            v1 auto-quotes the bread-and-butter jobs where photos and structured intake
            are sufficient. Safety-critical or hidden-state work always triggers a paid
            site visit — that&apos;s the liability shield.
          </p>
          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            <ScopeBlock
              tone="auto"
              label="Auto-quote in v1"
              items={[
                "Downlights / lighting",
                "Power points (GPOs)",
                "Ceiling fans",
                "Smoke alarms",
                "Outdoor / deck lighting",
              ]}
              footer="Bounded scope · predictable materials · photos sufficient. Tradie review still required — no auto-send until the eval framework hits 80%+."
            />
            <ScopeBlock
              tone="inspection"
              label="Inspection only"
              items={[
                "Switchboard work",
                "Fault finding",
                "EV chargers",
                "Underground cabling",
                "Multi-trade renovations",
              ]}
              footer="Hidden state can't be photographed. Surfaced as indicative range only — paid $199 site visit triggered, which converts into the actual job."
            />
          </div>
        </div>
      </section>

      {/* ═══════════════ STATUS ═══════════════ */}
      <section id="status" className="bg-zinc-900 text-white">
        <div className="mx-auto max-w-4xl px-6 py-20">
          <span className="inline-block text-xs font-semibold uppercase tracking-widest text-zinc-400">
            Status
          </span>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            Honestly: still building.
          </h2>
          <div className="mt-8 space-y-4 text-zinc-300">
            <p>
              QuoteMate is in active development. The pipeline (Stages 02 → 05) works
              end-to-end in dev. NSW pilot starts when the eval framework hits 80%+ on
              the 100-pair hold-out set — see{" "}
              <a href="/docs/architecture.html" className="text-white underline underline-offset-2">
                architecture
              </a>{" "}
              and{" "}
              <a href="/docs/build-guide.html" className="text-white underline underline-offset-2">
                build guide
              </a>{" "}
              for the technical detail.
            </p>
            <p>
              <strong className="text-white">Per-quote running cost:</strong> ~$0.07
              (typed portal path) or ~$0.50–0.75 (voice path). Per-tradie monthly pricing
              locks in once the pilot proves out.
            </p>
            <p>
              <strong className="text-white">Not yet built:</strong> tradie review
              dashboard, customer-facing quote view, Stripe Connect payment flow,
              follow-up SMS, calendar booking. Stages 06 → 10 of the wireframe.
            </p>
          </div>
          <div className="mt-10 flex flex-wrap gap-3">
            <a
              href="/docs/architecture.html"
              className="rounded-full bg-white px-6 py-3 text-sm font-semibold text-zinc-900 transition-colors hover:bg-zinc-100"
            >
              View architecture
            </a>
            <a
              href="/docs/build-guide.html"
              className="rounded-full border border-zinc-700 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-zinc-800"
            >
              Read build guide
            </a>
            <a
              href="/docs/beginner-walkthrough.html"
              className="rounded-full border border-zinc-700 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-zinc-800"
            >
              Beginner walkthrough
            </a>
          </div>
        </div>
      </section>

      {/* ═══════════════ FOOTER ═══════════════ */}
      <footer className="border-t border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-10 text-sm text-zinc-500">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-zinc-900 text-xs font-black text-white">
              Q
            </span>
            <span className="font-semibold text-zinc-700">QuoteMate</span>
          </div>
          <div>Built in Australia · NSW pilot · MIT licence</div>
        </div>
      </footer>
    </div>
  );
}

/* ─── Component primitives ─────────────────────────────────────────── */

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="text-2xl font-bold tracking-tight text-zinc-900">{value}</div>
      <div className="mt-1 text-xs uppercase tracking-widest text-zinc-500">{label}</div>
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block text-xs font-semibold uppercase tracking-widest text-blue-600">
      {children}
    </span>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6">
      <h3 className="text-lg font-semibold text-zinc-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-600">{body}</p>
    </div>
  );
}

function Stage({
  num,
  title,
  body,
  accent = "zinc",
}: {
  num: string;
  title: string;
  body: string;
  accent?: "zinc" | "amber" | "orange" | "cyan" | "violet";
}) {
  const borderTop = {
    zinc: "border-t-zinc-900",
    amber: "border-t-amber-500",
    orange: "border-t-orange-500",
    cyan: "border-t-cyan-500",
    violet: "border-t-violet-500",
  }[accent];
  return (
    <li className={`rounded-lg border border-zinc-200 border-t-4 ${borderTop} bg-white p-5`}>
      <div className="font-mono text-xs font-semibold tracking-widest text-zinc-400">
        {num}
      </div>
      <div className="mt-1 text-sm font-bold text-zinc-900">{title}</div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-600">{body}</p>
    </li>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <div className="h-px w-12 bg-zinc-900" />
      <h3 className="mt-4 text-base font-semibold text-zinc-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-600">{body}</p>
    </div>
  );
}

function ScopeBlock({
  tone,
  label,
  items,
  footer,
}: {
  tone: "auto" | "inspection";
  label: string;
  items: string[];
  footer: string;
}) {
  const styles =
    tone === "auto"
      ? {
          border: "border-emerald-300",
          bg: "bg-emerald-50",
          chip: "bg-emerald-100 text-emerald-700",
          footer: "text-emerald-900",
        }
      : {
          border: "border-rose-300",
          bg: "bg-rose-50",
          chip: "bg-rose-100 text-rose-700",
          footer: "text-rose-900",
        };
  return (
    <div className={`rounded-lg border ${styles.border} ${styles.bg} p-6`}>
      <span
        className={`inline-block rounded-md px-2 py-1 text-xs font-bold uppercase tracking-widest ${styles.chip}`}
      >
        {label}
      </span>
      <ol className="mt-4 list-inside list-decimal space-y-2 text-zinc-800">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
      <p className={`mt-4 text-xs ${styles.footer}`}>{footer}</p>
    </div>
  );
}
