import { describe, it, expect } from 'vitest'
import { buildPhotoRequestSms } from './templates'

// ════════════════════════════════════════════════════════════════════
// EV charger is the ONE job type whose location photo is required, not
// optional (spec ev-charger-location-photo R8) — the quote's AI render of the
// charger in position is built from it, and dialog.ts tells the model to
// "phrase it as needed rather than optional".
//
// Every other variant in buildPhotoRequestSms ends with some form of
// "optional". Without a dedicated branch an ev_charger customer is told the
// photo is optional and then held to a gate that requires it. That is exactly
// what happened live on 2026-09-08: the electrical receptionist service, which
// carries its own copy of this file, had never received the branch and texted
// an EV customer "Totally optional." while its own readiness gate withheld the
// quote pending a photo.
//
// So this pins the ev_charger copy in the platform, and the same assertions are
// what the carve-out has to satisfy when the file is synced.
// ════════════════════════════════════════════════════════════════════

const UPLOAD = 'https://quotemax.com.au/upload/58964c8c6d958cfe5cc337d8d875fc5d'

describe('buildPhotoRequestSms — ev_charger', () => {
  it('never calls the photo optional', () => {
    const sms = buildPhotoRequestSms({ firstName: 'Jeph', uploadUrl: UPLOAD, jobType: 'ev_charger' })
    expect(sms.toLowerCase()).not.toContain('optional')
    expect(sms.toLowerCase()).not.toContain('not required')
  })

  it('carries the upload link', () => {
    const sms = buildPhotoRequestSms({ firstName: 'Jeph', uploadUrl: UPLOAD, jobType: 'ev_charger' })
    expect(sms).toContain(UPLOAD)
  })

  it('is deterministic — one clear ask, not a random variant', () => {
    // The generic path picks at random. An EV customer must get the same
    // wording every time, so a follow-up never contradicts the first ask.
    const runs = new Set(
      Array.from({ length: 25 }, () =>
        buildPhotoRequestSms({ firstName: 'Jeph', uploadUrl: UPLOAD, jobType: 'ev_charger' }),
      ),
    )
    expect(runs.size).toBe(1)
  })

  it('still greets by name, and copes without one', () => {
    const named = buildPhotoRequestSms({ firstName: 'Jeph', uploadUrl: UPLOAD, jobType: 'ev_charger' })
    expect(named).toContain('Jeph')
    const anon = buildPhotoRequestSms({ uploadUrl: UPLOAD, jobType: 'ev_charger' })
    expect(anon).toContain(UPLOAD)
    expect(anon.toLowerCase()).not.toContain('optional')
  })

  it('leaves every other job type on the optional framing', () => {
    // The branch must be narrow: downlights and the rest keep the softer ask,
    // which is what makes them cheap for the customer to skip.
    const others = Array.from({ length: 40 }, () =>
      buildPhotoRequestSms({ firstName: 'Jeph', uploadUrl: UPLOAD, jobType: 'downlights' }),
    )
    expect(others.some((s) => /optional|not required/i.test(s))).toBe(true)
  })
})
