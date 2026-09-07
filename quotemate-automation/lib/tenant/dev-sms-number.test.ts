// Migration 197 — the development-only second SMS number on tenantByDestinationSms.
//
// The behaviour that matters is the ORDER and the GATE:
//   * both production lookups must win first, so a dev value can never
//     shadow a live number;
//   * the dev lookup must run ONLY when NODE_ENV === 'development', so a
//     number parked in that column can never route on Vercel (which sets
//     'production' on preview deploys too);
//   * a database without the column must degrade to "no tenant", never throw
//     into the SMS webhook.

import { describe, expect, it, vi, afterEach } from 'vitest'
import { tenantByDestinationSms } from './lookup'

const SPARKY = { id: 't1', business_name: 'Sparky', status: 'active' }

/** Minimal Supabase stub: one canned answer per (column) equality probe,
 *  plus the `.not(...)` fallback scan the real lookup performs. */
function stubSupabase(opts: {
  byLive?: unknown
  byDev?: unknown
  devError?: string
  scanRows?: unknown[]
}) {
  const probes: string[] = []
  const client = {
    from() {
      const q: Record<string, unknown> = {}
      q.select = () => q
      q.eq = (col: string) => {
        probes.push(col)
        q.__col = col
        return q
      }
      q.not = () => ({
        // The fallback scan resolves directly (no .maybeSingle()).
        then: (r: (v: unknown) => unknown) => r({ data: opts.scanRows ?? [], error: null }),
      })
      q.maybeSingle = async () => {
        if (q.__col === 'twilio_sms_number') return { data: opts.byLive ?? null, error: null }
        if (q.__col === 'twilio_sms_number_dev') {
          return opts.devError
            ? { data: null, error: { message: opts.devError } }
            : { data: opts.byDev ?? null, error: null }
        }
        return { data: null, error: null }
      }
      return q
    },
  }
  return { client: client as never, probes }
}

const withNodeEnv = async (value: string, fn: () => Promise<void>) => {
  vi.stubEnv('NODE_ENV', value)
  try {
    await fn()
  } finally {
    vi.unstubAllEnvs()
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('tenantByDestinationSms — dev number (mig 197)', () => {
  it('resolves a tenant by its dev number in development', async () => {
    const { client } = stubSupabase({ byDev: SPARKY })
    await withNodeEnv('development', async () => {
      const t = await tenantByDestinationSms(client, '+61489083371')
      expect(t?.business_name).toBe('Sparky')
    })
  })

  it('NEVER consults the dev column outside development', async () => {
    const { client, probes } = stubSupabase({ byDev: SPARKY })
    await withNodeEnv('production', async () => {
      const t = await tenantByDestinationSms(client, '+61489083371')
      expect(t).toBeNull()
    })
    expect(probes).not.toContain('twilio_sms_number_dev')
  })

  it('lets the LIVE number win — a dev value can never shadow production', async () => {
    const live = { ...SPARKY, business_name: 'Atomic Electrical' }
    const { client, probes } = stubSupabase({ byLive: live, byDev: SPARKY })
    await withNodeEnv('development', async () => {
      const t = await tenantByDestinationSms(client, '+61468011464')
      expect(t?.business_name).toBe('Atomic Electrical')
    })
    // Short-circuited on the first probe: the dev column is never reached.
    expect(probes).not.toContain('twilio_sms_number_dev')
  })

  it('degrades to null (does not throw) when the column is missing', async () => {
    const { client } = stubSupabase({
      devError: 'column tenants.twilio_sms_number_dev does not exist',
    })
    await withNodeEnv('development', async () => {
      await expect(tenantByDestinationSms(client, '+61489083371')).resolves.toBeNull()
    })
  })

  it('still returns null for a number nobody owns', async () => {
    const { client } = stubSupabase({})
    await withNodeEnv('development', async () => {
      await expect(tenantByDestinationSms(client, '+61400000000')).resolves.toBeNull()
    })
  })
})
