import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ════════════════════════════════════════════════════════════════════
// WIRING INVARIANT for POST /api/sms/inbound — the self-conversation guard.
//
// Twilio delivers to a number, and that number's own smsUrl then fires. So the
// moment a SECOND provisioned line is pointed at this webhook — the ordinary
// setup when a tenant-owned number is used as the test customer — every reply
// the agent sends arrives back here as an "inbound" whose From is one of our
// own agent lines. Both ends then answer each other. A live run on
// 2026-09-06 produced 104 messages before it was stopped by hand, and the
// same wiring was observed again on 2026-09-08 (ngrok recorded
// From=+61468048422 To=+61489083371 POSTs into /api/sms/inbound).
//
// The guard is one lookup: if the SENDER resolves to a provisioned tenant line,
// ack Twilio and write nothing. What actually breaks production is not the
// lookup being wrong, it is the guard being moved, so this pins its POSITION —
// it must run before the destination lookup and before the first write.
//
// The route module cannot be imported here: it calls createClient() at module
// scope and vitest.config.ts injects no env, so the import throws. Same
// constraint, and same source-level approach, as tests/internal-route-auth.ts.
// ════════════════════════════════════════════════════════════════════

const ROOT = resolve(__dirname, '..')
const src = readFileSync(resolve(ROOT, 'app/api/sms/inbound/route.ts'), 'utf8')

describe('POST /api/sms/inbound — self-conversation guard', () => {
  const guardIdx = src.indexOf('isProvisionedAgentNumber(supabase, fromNumber)')
  const destIdx = src.indexOf('tenantByDestinationSms(supabase, toNumber)')

  it('looks the SENDER up against the provisioned agent lines', () => {
    expect(
      guardIdx,
      'the guard must resolve fromNumber via the live-line check',
    ).toBeGreaterThan(-1)
  })

  it('acks Twilio instead of erroring, so a stray inbound is not retried forever', () => {
    // A 4xx/5xx would make Twilio retry a self-message on a schedule, and a
    // retry cannot fix a webhook misconfiguration — it just multiplies it.
    const guardBlock = src.slice(guardIdx, guardIdx + 700)
    expect(guardBlock).toMatch(/return ackTwiml\(\)/)
  })

  it('runs BEFORE the destination lookup', () => {
    expect(destIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(destIdx)
  })

  it('runs BEFORE anything is written — no customer row, no conversation, no reply', () => {
    // The first persistence call anywhere in the handler must come after the
    // guard. If a write ever moves above it, a looped message starts creating
    // rows again even though the reply is suppressed.
    const firstWrite = [...src.matchAll(/\.(insert|upsert|update)\(/g)]
      .map((m) => m.index ?? -1)
      .filter((i) => i > src.indexOf('export async function POST'))
      .sort((a, b) => a - b)[0]
    expect(firstWrite, 'expected at least one write in the handler').toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(firstWrite)
  })
})
