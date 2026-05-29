'use client'

// /admin — Roofing activation panel.
//
// Lists every tenant and shows a one-click toggle to add or remove
// the 'roofing' trade from their tenants.trades[] array. Admin-gated.
//
// This bypasses the v9 §10 activate flow (which depends on prod
// migrations 053-055 that aren't applied yet) — see the comment block
// at app/api/admin/tenants/[id]/toggle-roofing/route.ts.

import { useCallback, useEffect, useState } from 'react'
import { getBrowserSupabase } from '@/lib/supabase/client'

type Tenant = {
  id: string
  businessName: string | null
  state: string | null
  trade: string | null
  trades: string[]
  status: string | null
  createdAt: string | null
}

type ListResponse =
  | { ok: true; tenants: Tenant[] }
  | { ok: false; error: string }

type ToggleResponse =
  | { ok: true; tenantId: string; businessName: string | null; trades: string[]; wasNoop: boolean }
  | { ok: false; error: string }

export function RoofingActivation() {
  const [token, setToken] = useState<string | null>(null)
  const [tenants, setTenants] = useState<Tenant[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [lastMsg, setLastMsg] = useState<string | null>(null)

  const load = useCallback(async (t: string) => {
    setErr(null)
    try {
      const res = await fetch('/api/admin/tenants', {
        headers: { Authorization: `Bearer ${t}` },
        cache: 'no-store',
      })
      const json = (await res.json()) as ListResponse
      if (!json.ok) {
        setErr(json.error)
        return
      }
      setTenants(json.tenants)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    const sb = getBrowserSupabase()
    sb.auth.getSession().then(({ data: { session } }) => {
      const t = session?.access_token ?? null
      setToken(t)
      if (t) void load(t)
    })
  }, [load])

  const toggle = useCallback(
    async (tenantId: string, enable: boolean, businessName: string | null) => {
      if (!token) return
      setBusyId(tenantId)
      setLastMsg(null)
      try {
        const res = await fetch(`/api/admin/tenants/${tenantId}/toggle-roofing`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ enable }),
        })
        const json = (await res.json()) as ToggleResponse
        if (!json.ok) {
          setLastMsg(`Failed: ${json.error}`)
          return
        }
        setLastMsg(
          `${businessName ?? tenantId.slice(0, 8)} — roofing ${enable ? 'enabled' : 'disabled'}${json.wasNoop ? ' (already in that state)' : ''}.`,
        )
        await load(token)
      } catch (e) {
        setLastMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusyId(null)
      }
    },
    [token, load],
  )

  return (
    <section className="relative z-10 mx-auto max-w-7xl px-6 pb-16 pt-12 sm:px-10">
      <div>
        <div className="font-mono text-[0.8rem] font-semibold uppercase tracking-[0.18em] text-accent">
          Roofing activation
        </div>
        <h2 className="mt-3 font-extrabold uppercase tracking-tight text-[clamp(1.5rem,2.6vw,2.25rem)] leading-[1.1]">
          Turn roofing on for a tenant
        </h2>
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-text-sec">
          Adds <code className="font-mono">&apos;roofing&apos;</code> to the tenant&apos;s
          <code className="font-mono"> trades[]</code> array so the sidebar
          shows the <span className="text-text-pri">Roof</span> tab and the
          conditional gating on
          <code className="font-mono"> /dashboard/roofing/measure</code>
          accepts them. Idempotent — clicking twice is safe.
        </p>
      </div>

      {err && (
        <div className="mt-6 border border-ink-line border-l-4 border-l-warning bg-ink-card px-5 py-4">
          <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-warning">
            Could not load tenants
          </div>
          <p className="mt-1 text-base text-text-sec">{err}</p>
        </div>
      )}

      {lastMsg && (
        <div className="mt-6 border border-ink-line border-l-4 border-l-accent bg-ink-card px-5 py-4">
          <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-accent">
            Result
          </div>
          <p className="mt-1 text-base text-text-sec">{lastMsg}</p>
        </div>
      )}

      <div className="mt-8 border border-ink-line bg-ink-card">
        {tenants === null ? (
          <p className="px-6 py-6 text-base text-text-dim">Loading tenants…</p>
        ) : tenants.length === 0 ? (
          <p className="px-6 py-6 text-base text-text-dim">No tenants found.</p>
        ) : (
          <ul className="divide-y divide-ink-line">
            {tenants.map((t) => {
              const hasRoof = t.trades.includes('roofing')
              return (
                <li
                  key={t.id}
                  className="flex flex-wrap items-center justify-between gap-5 px-6 py-5 sm:px-8"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-lg font-semibold text-text-pri">
                      {t.businessName ?? <span className="text-text-dim">(no name)</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-xs uppercase tracking-[0.14em] text-text-dim">
                      <span>id {t.id.slice(0, 8)}…</span>
                      {t.state && <span>· {t.state}</span>}
                      {t.status && <span>· {t.status}</span>}
                      <span>·</span>
                      <span>Trades: {t.trades.length === 0 ? '(none)' : t.trades.join(' + ')}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(t.id, !hasRoof, t.businessName)}
                    disabled={busyId === t.id}
                    className={`inline-flex items-center gap-2 px-5 py-3 font-mono text-sm font-semibold uppercase tracking-[0.14em] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      hasRoof
                        ? 'border border-ink-line text-text-sec hover:border-warning hover:text-warning'
                        : 'bg-accent text-white hover:bg-accent-press'
                    }`}
                  >
                    {busyId === t.id ? (
                      <>
                        <span className="inline-block h-3.5 w-3.5 animate-spin border-2 border-white/40 border-t-white" aria-hidden="true" />
                        Saving…
                      </>
                    ) : hasRoof ? (
                      <>Roofing on · disable</>
                    ) : (
                      <>Enable roofing <span aria-hidden="true">&rarr;</span></>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
