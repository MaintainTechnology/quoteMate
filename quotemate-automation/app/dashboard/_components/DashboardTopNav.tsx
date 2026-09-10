'use client'

// Persistent back-to-dashboard bar for every /dashboard sub-route
// (specs/dashboard-persistent-nav.md). Mirrors the admin shell's nav language
// (app/admin/layout.tsx) at slim height: the root /dashboard page renders its
// own full topbar, so the bar hides there (showDashboardNav). Sub-page sticky
// chrome sticks at top-11, directly below this h-11 bar.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { showDashboardNav } from './dashboard-nav'

export default function DashboardTopNav() {
  const pathname = usePathname()
  const showBack = showDashboardNav(pathname)

  return (
    <nav
      aria-label="Dashboard"
      // Height and border on ONE border-box element so the bar is exactly
      // 44px — the top-11 offsets on sub-page sticky chrome depend on it.
      className="sticky top-0 z-40 flex h-11 items-center border-b border-ink-line bg-ink-deep/90 px-4 backdrop-blur-md sm:px-5"
    >
      {showBack && <Link
        href="/dashboard"
        className="flex items-center gap-2 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-text-pri"
      >
        <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        Dashboard
      </Link>}
      <div className="ml-auto flex items-center gap-4 text-xs text-text-dim">
        <Link className="hover:text-text-pri" href="/dashboard/sms-recovery">Enquiry recovery</Link>
        <Link className="hover:text-text-pri" href="/dashboard/sms-delivery">SMS delivery</Link>
      </div>
    </nav>
  )
}
