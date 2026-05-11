// Customer-facing photo upload page.
// Reached via the SMS link "Tap here to add 1-2 photos: {APP_URL}/upload/{token}".
// Same trust model as the quote page — token is unguessable.
//
// Design: Maintain Technology brand (dark navy canvas, orange accent,
// numbered cards, JetBrains Mono labels). Matches the look of /q/[token]
// so customers see one consistent visual identity across the journey.

import { createClient } from '@supabase/supabase-js'
import Link from 'next/link'
import { UploadForm } from './UploadForm'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export default async function UploadPage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params

  // Resolve the token in EITHER source table:
  //   • calls.photo_request_token         — voice-agent flow
  //   • sms_conversations.photo_request_token — SMS-agent flow
  const { data: call } = await supabase
    .from('calls')
    .select('id, photo_request_token, photos_completed_at')
    .eq('photo_request_token', token)
    .maybeSingle()

  let resolved: { source: 'call' | 'sms'; completedAt: string | null } | null = null
  if (call) {
    resolved = { source: 'call', completedAt: call.photos_completed_at as string | null }
  } else {
    const { data: convo } = await supabase
      .from('sms_conversations')
      .select('id, photo_request_token, photos_completed_at')
      .eq('photo_request_token', token)
      .maybeSingle()
    if (convo) {
      resolved = { source: 'sms', completedAt: convo.photos_completed_at as string | null }
    }
  }

  // ─── Invalid / expired link ───
  if (!resolved) {
    return (
      <Shell>
        <StateCard
          eyebrow="Invalid link"
          title="LINK NOT FOUND"
          body="This upload link is invalid or has expired. Reply to your QuoteMate SMS if you need a fresh one."
          tone="warning"
        />
      </Shell>
    )
  }

  // ─── Already received ───
  if (resolved.completedAt) {
    return (
      <Shell>
        <StateCard
          eyebrow="All done"
          title="PHOTOS RECEIVED"
          body="Thanks — your photos are with us. Your quote will arrive by SMS shortly if it hasn't already."
          tone="success"
        />
      </Shell>
    )
  }

  // ─── Live upload state ───
  return (
    <Shell>
      <section>
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.15em] text-text-dim">
          Photos · QuoteMate intake
        </span>
        <h1 className="mt-4 font-extrabold uppercase tracking-[-0.03em] text-[clamp(1.75rem,5vw,3rem)] leading-none">
          Add <span className="text-accent">photos</span><br />
          for your quote
        </h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed text-text-sec sm:text-lg">
          A photo or two of the area helps your tradie spot anything tricky and lock in the price.
          Up to <span className="font-semibold text-text-pri">5 photos</span>, JPEG / PNG / WebP, max 5MB each.
        </p>
      </section>

      {/* ─── 01 — the upload form itself ─── */}
      <section className="mt-10 bg-ink-card border border-ink-line p-6 sm:p-8">
        <div className="flex items-start gap-5 sm:gap-6">
          <span className="font-mono text-3xl sm:text-4xl font-bold text-accent leading-none shrink-0">
            01
          </span>
          <div className="flex-1 min-w-0">
            <h2 className="text-text-pri font-extrabold uppercase tracking-tight text-base sm:text-lg">
              Snap or pick your photos
            </h2>
            <p className="mt-1 text-xs text-text-dim">
              Use your camera for the freshest shot, or pick existing photos from your gallery.
            </p>
            <div className="mt-5">
              <UploadForm token={token} />
            </div>
          </div>
        </div>
      </section>

      {/* ─── 02 — quick tips ─── */}
      <section className="mt-6 bg-ink-card border border-ink-line p-6 sm:p-8">
        <div className="flex items-start gap-5 sm:gap-6">
          <span className="font-mono text-3xl sm:text-4xl font-bold text-accent leading-none shrink-0">
            02
          </span>
          <div className="flex-1 min-w-0">
            <h2 className="text-text-pri font-extrabold uppercase tracking-tight text-base sm:text-lg">
              What makes a good photo
            </h2>
            <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-text-sec">
              <li className="flex gap-3">
                <span className="text-accent shrink-0 font-mono">›</span>
                <span>Capture the area being worked on — ceiling, wall, fixture, etc.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-accent shrink-0 font-mono">›</span>
                <span>Daylight or strong room light — phone flash is fine if it&apos;s dark</span>
              </li>
              <li className="flex gap-3">
                <span className="text-accent shrink-0 font-mono">›</span>
                <span>Step back so the whole area is in frame — close-ups can come second</span>
              </li>
              <li className="flex gap-3">
                <span className="text-accent shrink-0 font-mono">›</span>
                <span>1–2 photos is plenty — more is fine but not required</span>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </Shell>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Components — kept in this file because they're upload-specific
   layout chrome. MaintainLogo / TopographicBackground duplicate the
   ones in app/q/[token]/page.tsx; if a third surface needs them
   they should be extracted to a shared component then.
   ═══════════════════════════════════════════════════════════════ */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-ink-deep text-text-pri relative">
      <TopographicBackground />

      <header className="relative z-10 border-b border-ink-line bg-ink-deep/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="inline-flex items-center group" aria-label="Maintain Technology">
            <MaintainLogo className="h-8 sm:h-9 w-auto transition-transform group-hover:-translate-y-0.5" />
          </Link>
          <div className="text-right">
            <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-text-dim">Photo upload</div>
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-16">
        {children}

        <p className="mt-12 text-center font-mono text-[0.65rem] uppercase tracking-[0.2em] text-text-dim">
          Powered by <Link href="/" className="text-text-sec hover:text-accent transition-colors">QuoteMate</Link> · Built in Australia
        </p>
      </div>

      <div className="relative z-10 bg-accent text-white text-center py-4 px-6 mt-8">
        <span className="font-mono text-xs sm:text-sm uppercase tracking-[0.18em]">
          Tap to add photos · 1–2 is plenty
        </span>
      </div>
    </main>
  )
}

function StateCard({
  eyebrow,
  title,
  body,
  tone,
}: {
  eyebrow: string
  title: string
  body: string
  tone: 'success' | 'warning'
}) {
  const toneStyles =
    tone === 'success'
      ? 'border-success/40 text-[#34d399]'
      : 'border-warning/50 text-[#fbbf24]'
  return (
    <section className={`bg-ink-card border-2 ${toneStyles} p-8 sm:p-10`}>
      <div className={`font-mono text-[0.7rem] uppercase tracking-[0.15em] mb-4`}>
        {eyebrow}
      </div>
      <h1 className="text-text-pri font-extrabold uppercase tracking-tight text-3xl sm:text-4xl">
        {title}
      </h1>
      <p className="mt-4 text-base leading-relaxed text-text-sec sm:text-lg">
        {body}
      </p>
    </section>
  )
}

function MaintainLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 184 39"
      fill="none"
      className={className}
      role="img"
      aria-label="Maintain Technology"
    >
      <g clipPath="url(#mt-up-logo-clip)">
        <path d="M76.1019 29.7139H73.5806V36.6808H72.1687V29.7139H69.6475V28.417H76.1023V29.7139H76.1019Z" fill="white" />
        <path d="M82.3761 29.7139V31.9007H86.171V33.1976H82.3761V35.384H86.4355V36.6808H80.9766V28.417H86.4355V29.7139H82.3761Z" fill="white" />
        <path d="M95.4282 29.7263C93.8018 29.7263 92.7052 30.9212 92.7052 32.5489C92.7052 34.1765 93.8022 35.3714 95.4282 35.3714C96.399 35.3714 97.1804 34.8377 97.6091 34.2402L98.7437 35.1172C98.0378 36.147 96.878 36.7827 95.4282 36.7827C92.9952 36.7827 91.3057 35.0028 91.3057 32.5489C91.3057 30.0949 92.9952 28.3154 95.4282 28.3154C96.878 28.3154 98.0378 28.9512 98.7437 29.9809L97.6091 30.8201C97.1804 30.2098 96.399 29.7267 95.4282 29.7267V29.7263Z" fill="white" />
        <path d="M110.276 28.417V36.6808H108.877V33.2354H105.069V36.6808H103.67V28.417H105.069V31.8624H108.877V28.417H110.276Z" fill="white" />
        <path d="M122.284 28.417V36.6808H120.923L117.153 30.8705V36.6808H115.754V28.417H117.115L120.885 34.2273V28.417H122.284Z" fill="white" />
        <path d="M127.468 32.5489C127.468 30.0954 129.157 28.3154 131.59 28.3154C134.023 28.3154 135.688 30.0954 135.688 32.5489C135.688 35.0024 134.023 36.7827 131.59 36.7827C129.157 36.7827 127.468 35.0028 127.468 32.5489ZM134.276 32.5489C134.276 30.9216 133.217 29.7263 131.59 29.7263C129.964 29.7263 128.867 30.9212 128.867 32.5489C128.867 34.1765 129.964 35.3714 131.59 35.3714C133.217 35.3714 134.276 34.1765 134.276 32.5489Z" fill="white" />
        <path d="M146.268 35.384V36.6808H140.834V28.417H142.233V35.384H146.268Z" fill="white" />
        <path d="M150.666 32.5489C150.666 30.0954 152.356 28.3154 154.789 28.3154C157.222 28.3154 158.886 30.0954 158.886 32.5489C158.886 35.0024 157.222 36.7827 154.789 36.7827C152.356 36.7827 150.666 35.0028 150.666 32.5489ZM157.474 32.5489C157.474 30.9216 156.415 29.7263 154.789 29.7263C153.162 29.7263 152.066 30.9212 152.066 32.5489C152.066 34.1765 153.163 35.3714 154.789 35.3714C156.415 35.3714 157.474 34.1765 157.474 32.5489Z" fill="white" />
        <path d="M167.854 36.7827C165.421 36.7827 163.731 35.0028 163.731 32.5489C163.731 30.0949 165.421 28.3154 167.854 28.3154C169.304 28.3154 170.464 28.9512 171.17 29.968L170.023 30.8072C169.506 30.0824 168.699 29.7267 167.854 29.7267C166.228 29.7267 165.131 30.9216 165.131 32.5493C165.131 34.177 166.228 35.3719 167.854 35.3719C169.014 35.3719 169.997 34.66 170.186 33.4139H167.766V32.117H171.788V32.7403C171.699 35.0923 170.224 36.7832 167.854 36.7832V36.7827Z" fill="white" />
        <path d="M180.088 33.121V36.6808H178.688V33.1593L175.764 28.417H177.377L179.382 31.659L181.387 28.417H183L180.088 33.121Z" fill="white" />
        <path d="M91.3279 22.9581H87.6423L86.1248 10.9332L81.3549 22.9581H79.6205L74.8506 10.9332L73.3331 22.9581H69.6475L72.2493 4.59277H75.718L80.4879 16.3989L85.2578 4.59277H88.7266L91.3284 22.9581H91.3279Z" fill="white" />
        <path d="M108.014 9.4017V22.9569H104.546V21.5087C103.462 22.7659 102.052 23.3942 100.426 23.3942C96.7136 23.3942 93.7051 20.1693 93.7051 16.179C93.7051 12.1888 96.7131 8.96387 100.426 8.96387C102.052 8.96387 103.462 9.59224 104.546 10.8494V9.40123H108.014V9.4017ZM104.546 16.1795C104.546 14.1297 102.893 12.4628 100.86 12.4628C98.8273 12.4628 97.1743 14.1297 97.1743 16.1795C97.1743 18.2293 98.8273 19.8962 100.86 19.8962C102.893 19.8962 104.546 18.2293 104.546 16.1795Z" fill="white" />
        <path d="M111.993 9.40234H115.462V22.9575H111.993V9.40234Z" fill="white" />
        <path d="M111.993 4.5918H115.462V7.65291H111.993V4.5918Z" fill="white" />
        <path d="M163.008 4.5918H166.477V7.65291H163.008V4.5918Z" fill="white" />
        <path d="M131.985 15.0871V22.9578H128.516V15.5244C128.516 13.4202 127.703 12.4633 125.914 12.4633C124.342 12.4633 122.879 13.5018 122.879 15.9613V22.9578H119.41V9.40221H122.879V10.7139C123.8 9.6209 124.912 8.96484 126.944 8.96484C130.034 8.96484 131.985 10.9874 131.985 15.0866V15.0871Z" fill="white" />
        <path d="M136.303 12.463H134.568V9.40192H136.303V4.5918H139.772V9.40192H142.373V12.463H139.772V18.1474C139.772 20.2245 140.666 20.3066 142.373 19.8964V22.9575C141.696 23.2307 140.964 23.3949 139.826 23.3949C137.36 23.3949 136.303 21.6187 136.303 19.1043V12.463Z" fill="white" />
        <path d="M159.029 9.4017V22.9569H155.56V21.5087C154.476 22.7659 153.067 23.3942 151.441 23.3942C147.728 23.3942 144.72 20.1693 144.72 16.179C144.72 12.1888 147.728 8.96387 151.441 8.96387C153.067 8.96387 154.476 9.59224 155.56 10.8494V9.40123H159.029V9.4017ZM155.56 16.1795C155.56 14.1297 153.907 12.4628 151.875 12.4628C149.842 12.4628 148.189 14.1297 148.189 16.1795C148.189 18.2293 149.842 19.8962 151.875 19.8962C153.907 19.8962 155.56 18.2293 155.56 16.1795Z" fill="white" />
        <path d="M163.008 9.40234H166.477V22.9575H163.008V9.40234Z" fill="white" />
        <path d="M183.001 15.0871V22.9578H179.532V15.5244C179.532 13.4202 178.719 12.4633 176.93 12.4633C175.358 12.4633 173.895 13.5018 173.895 15.9613V22.9578H170.426V9.40221H173.895V10.7139C174.816 9.6209 175.927 8.96484 177.96 8.96484C181.049 8.96484 183.001 10.9874 183.001 15.0866V15.0871Z" fill="white" />
        <path d="M60.5416 21.3594V38.5104C60.5416 38.7812 60.3238 39.0003 60.0557 39.0003H44.2212C43.7884 39.0003 43.5716 38.4725 43.8776 38.1639L60.5416 21.3594Z" fill="#FF5F00" />
        <path d="M60.5416 0.490945V21.3591H57.1749C56.5307 21.3591 55.9126 21.6175 55.457 22.0765L38.8177 38.8561C38.7266 38.9479 38.6031 38.9996 38.4741 38.9996H22.355C21.9222 38.9996 21.7054 38.4718 22.0114 38.1632L59.7117 0.144465C60.0178 -0.164184 60.5412 0.0544997 60.5412 0.490945H60.5416Z" fill="#FF5F00" />
        <path d="M38.6739 0.490945V21.3591H35.3072C34.663 21.3591 34.0449 21.6175 33.5892 22.0765L16.95 38.8561C16.8589 38.9479 16.7354 38.9996 16.6064 38.9996H0.486839C0.0540439 38.9996 -0.162811 38.4718 0.143256 38.1632L37.8445 0.144465C38.1505 -0.164184 38.6739 0.0544997 38.6739 0.490945Z" fill="#FF5F00" />
      </g>
      <defs>
        <clipPath id="mt-up-logo-clip">
          <rect width="184" height="39" fill="white" />
        </clipPath>
      </defs>
    </svg>
  )
}

function TopographicBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
      <svg
        className="absolute inset-0 w-full h-full opacity-[0.07]"
        viewBox="0 0 1920 1600"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="topo-up-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--teal-glow)" stopOpacity="0.6" />
            <stop offset="100%" stopColor="var(--teal-glow)" stopOpacity="0.1" />
          </linearGradient>
        </defs>
        <g stroke="url(#topo-up-fade)" strokeWidth="1" fill="none">
          <path d="M0,500 Q200,360 400,420 T800,400 T1200,440 T1600,360 T1920,400" />
          <path d="M0,560 Q200,440 400,480 T800,470 T1200,500 T1600,440 T1920,470" />
          <path d="M0,640 Q220,540 420,560 T820,560 T1220,580 T1620,520 T1920,540" />
          <path d="M0,740 Q240,640 440,660 T840,660 T1240,680 T1640,620 T1920,640" />
          <path d="M0,900 Q260,780 460,820 T860,810 T1260,830 T1660,780 T1920,800" />
          <path d="M0,1100 Q280,980 480,1020 T880,1010 T1280,1030 T1680,980 T1920,1000" />
          <path d="M0,1300 Q300,1180 500,1220 T900,1210 T1300,1230 T1700,1180 T1920,1200" />
        </g>
      </svg>
    </div>
  )
}
