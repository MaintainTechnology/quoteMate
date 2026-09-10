// Phase 1b — the electrical/generic dialog turn may not ship a figure,
// product name or link that no tool produced.
//
// Roofing has had this guard since llm-receptionist.ts shipped; the
// electrical branch never did, and its prompt actively taught the model to
// write dollar amounts. This proves BOTH directions, because a false
// positive here is as harmful as a leak: electrical has no deterministic
// state machine to revert to, only a holding line, so every needless bail
// costs the customer a real answer.
//
// Pure — no DB, no model, no route. Mirrors lib/sms/grounding-corpus.test.ts.

import { describe, it, expect } from 'vitest'
import {
  enforceDialogGrounding,
  composeInspectionOffer,
  stripLinkPromise,
  type DialogDecisionLike,
} from './dialog-grounding'
import { INSPECTION_FEE_AUD } from '@/lib/quote/money'

// Tool-produced context only. Deliberately NOT prior outbound bodies:
// on the electrical path those are unguarded model text, so seeding them
// would launder one hallucinated figure into permanent authority.
const AUTH = [
  '{"first_name":"Sam","suburb":"Chandler","job_type":"downlights","count":6}',
  'MUST ASK downlights: how many, ceiling type, and whether there is 600 mm clearance above a shower or bath.',
  'Tenant catalogue options: Brilliant Halo 90 9W LED downlight, Clipsal 2000 series double GPO 10A.',
]
const CUST = ['need 6 downlights done', 'we are at 12 Smith Street Bondi', 'the 9W ones thanks']

const FALLBACK = "Thanks - we'll be right back to confirm details, just a quick snag on our end."

function decision(reply: string, over: Partial<DialogDecisionLike> = {}): DialogDecisionLike {
  return {
    action: 'ask',
    reply_to_send: reply,
    ready_for_intake: false,
    job_type_guess: 'downlights',
    ...over,
  }
}

// Model text that must never reach a customer.
const REJECT = [
  'Clipsal 2000 series, about $180 each installed.',
  "That'll be 75 mate.",
  'Downlights run 90 each fitted.',
  'Our hourly is 95 plus GST.',
  'The deposit is five hundred.',
  '10% off if you book this week.',
  'Ninety-nine to come out and look.',
  'See www.quotemax.com.au/q/FAKE123 for your quote.',
  // 47 appears in neither corpus. (A count that DOES appear as the
  // customer's street number is legitimately grounded — the guard cannot
  // tell "12 models" from "12 Smith Street", and weakening it is out of
  // bounds because roofing and painting share it.)
  'We have 47 downlight models in stock.',
  'Want me to text you a $99 inspection booking?',
]

// Ordinary electrical receptionist prose that MUST survive untouched.
const PASS = [
  "No worries - quick one, what's your first name?",
  "Cheers Sam - and what suburb's the job in?",
  'How many downlights are we doing?',
  'Are they going into a plasterboard or a raked ceiling?',
  'Is there 600 mm clearance above the shower or bath?',
  'Are they the 9W ones?',
  'Righto, 6 downlights in Chandler - anything else while we are there?',
  'Is the existing wiring already there, or is this a new run?',
  'Good one - I will flick through a couple of options for you in a sec.',
  'Thanks Sam, I have got that noted.',
  'Sorry, I did not catch a suburb there.',
  'All good - I will get that organised for you.',
]

describe('Phase 1b — dialog reply grounding', () => {
  it('swaps a model reply that invents a figure, brand price or link', () => {
    for (const r of REJECT) {
      const out = enforceDialogGrounding({
        decision: decision(r),
        authoritative: AUTH,
        conversational: CUST,
        fallbackReply: FALLBACK,
        modelAuthored: true,
      })
      expect(out.grounded, `should have been rejected: ${r}`).toBe(false)
      expect(out.decision.reply_to_send).toBe(FALLBACK)
    }
  })

  it('leaves ordinary electrical prose completely untouched', () => {
    // Every bail here costs the customer a real answer, so this direction
    // matters more than the reject list.
    for (const r of PASS) {
      const out = enforceDialogGrounding({
        decision: decision(r),
        authoritative: AUTH,
        conversational: CUST,
        fallbackReply: FALLBACK,
        modelAuthored: true,
      })
      expect(out.grounded, `should have passed: ${r} (${out.reason})`).toBe(true)
      expect(out.decision.reply_to_send).toBe(r)
    }
  })

  it('changes only reply_to_send on a bail — never the routing fields', () => {
    const original = decision('That will be $450 all up.', {
      action: 'finish',
      ready_for_intake: true,
      job_type_guess: 'downlights',
    })
    const out = enforceDialogGrounding({
      decision: original,
      authoritative: AUTH,
      conversational: CUST,
      fallbackReply: FALLBACK,
      modelAuthored: true,
    })
    expect(out.grounded).toBe(false)
    expect(out.decision.action).toBe('finish')
    expect(out.decision.ready_for_intake).toBe(true)
    expect(out.decision.job_type_guess).toBe('downlights')
    expect(out.decision.reply_to_send).not.toBe(original.reply_to_send)
  })

  it('the fallback line itself passes the guard, so a bail can never loop', () => {
    const out = enforceDialogGrounding({
      decision: decision(FALLBACK),
      authoritative: AUTH,
      conversational: CUST,
      fallbackReply: FALLBACK,
      modelAuthored: true,
    })
    expect(out.grounded).toBe(true)
  })

  it('does not guard a route-composed reply — deterministic text is trusted', () => {
    // The $99 offer can never satisfy the guard (money is refused before any
    // grounding lookup). That is why the route composes it and the guard is
    // scoped to model-authored text, exactly as roofing trusts its composer.
    const composed = composeInspectionOffer('downlights', 'Sam')
    const out = enforceDialogGrounding({
      decision: decision(composed, { action: 'escalate_inspection' }),
      authoritative: AUTH,
      conversational: CUST,
      fallbackReply: FALLBACK,
      modelAuthored: false,
    })
    expect(out.grounded).toBe(true)
    expect(out.decision.reply_to_send).toBe(composed)
  })
})

// Review findings A and B — both are real replies the guard wrongly bailed on
// in the first cut of this change. A: the follow-up quote link is tool-produced
// but was missing from `authoritative`. B: the prompt's own taught GOOD examples
// are DECLARATIVE, so the free-question exemption (which needs a '?') does not
// apply and their filler numbers must be grounded.
describe('Phase 1b — false positives the review caught', () => {
  const FOLLOWUP_BLOCK =
    'ACTIVE FOLLOW-UP QUOTE\n  - Quote link (their existing quote): https://www.quotemax.com.au/q/AbC123\n'

  it('A — resending the real follow-up quote link is not a bail', () => {
    const out = enforceDialogGrounding({
      decision: decision('No worries - here it is: https://www.quotemax.com.au/q/AbC123'),
      authoritative: [...AUTH, FOLLOWUP_BLOCK],
      conversational: CUST,
      fallbackReply: FALLBACK,
      modelAuthored: true,
    })
    expect(out.grounded, out.reason ?? '').toBe(true)
  })

  it('A — a link NOT in the follow-up block is still a bail', () => {
    const out = enforceDialogGrounding({
      decision: decision('Here you go: https://www.quotemax.com.au/q/NOTREAL'),
      authoritative: [...AUTH, FOLLOWUP_BLOCK],
      conversational: CUST,
      fallbackReply: FALLBACK,
      modelAuthored: true,
    })
    expect(out.grounded).toBe(false)
  })

  // Fixed prompt-side rather than by whitelisting filler numbers: the two
  // taught GOOD examples no longer contain an ungrounded figure at all, so the
  // model is never shown a pattern the guard must reject.
  it('B — the reworded declarative wrap-up is not a bail', () => {
    const out = enforceDialogGrounding({
      decision: decision(
        "Cheers Sam - quoting 6 downlights, flat plaster ceiling, existing wiring. Reply if anything's off, otherwise your quote's on its way.",
        { action: 'finish', ready_for_intake: true },
      ),
      authoritative: AUTH,
      conversational: CUST,
      fallbackReply: FALLBACK,
      modelAuthored: true,
    })
    expect(out.grounded, out.reason ?? '').toBe(true)
  })

  it('B — the reworded default-assumption line is not a bail', () => {
    const out = enforceDialogGrounding({
      decision: decision(
        "I'll quote on standard warm white unless you've got something specific in mind.",
      ),
      authoritative: AUTH,
      conversational: CUST,
      fallbackReply: FALLBACK,
      modelAuthored: true,
    })
    expect(out.grounded, out.reason ?? '').toBe(true)
  })

  it('B — an ungrounded ETA number is STILL a bail (guard not weakened)', () => {
    const out = enforceDialogGrounding({
      decision: decision("All sorted - your quote lands in 2 mins.", {
        action: 'finish',
        ready_for_intake: true,
      }),
      authoritative: AUTH,
      conversational: CUST,
      fallbackReply: FALLBACK,
      modelAuthored: true,
    })
    expect(out.grounded).toBe(false)
  })
})

describe('Phase 1b — composeInspectionOffer', () => {
  it('states the real fee from the shared constant', () => {
    expect(composeInspectionOffer('downlights', 'Sam')).toContain(`$${INSPECTION_FEE_AUD}`)
  })

  it('fits the 320-character reply_to_send cap', () => {
    for (const jt of ['downlights', 'hot_water', 'unknown', null]) {
      expect(composeInspectionOffer(jt, 'Sam').length).toBeLessThanOrEqual(320)
      expect(composeInspectionOffer(jt, null).length).toBeLessThanOrEqual(320)
    }
  })

  it('picks the tradie noun from the trade, not a generic one', () => {
    expect(composeInspectionOffer('downlights', null)).toContain('sparky')
    expect(composeInspectionOffer('hot_water', null)).toContain('plumber')
    expect(composeInspectionOffer('unknown', null)).toMatch(/someone/i)
  })

  // Found by the live test: `switchboard` is a prompt trigger word but is NOT
  // in the job_type_guess enum, so an escalation for it always arrives as
  // 'unknown'. Without a trade hint the offer degrades to "send someone out"
  // for a job that is unambiguously electrical — worse copy than the prompt
  // it replaced.
  it('falls back to the tenant trade when the job type is unknown', () => {
    expect(composeInspectionOffer('unknown', null, ['electrical'])).toContain('sparky')
    expect(composeInspectionOffer('unknown', null, ['plumbing'])).toContain('plumber')
  })

  it('stays generic when the tenant does both trades and the job is unknown', () => {
    expect(composeInspectionOffer('unknown', null, ['electrical', 'plumbing'])).toMatch(/someone/i)
  })

  it('a known job type still wins over the trade hint', () => {
    expect(composeInspectionOffer('hot_water', null, ['electrical'])).toContain('plumber')
  })
})

describe('stripLinkPromise', () => {
  // Verbatim from the reported thread (Sparky, 2026-09-07). The customer asked
  // three times; every one of these shipped with no URL anywhere in the SMS.
  const REPORTED = [
    "Good on ya Jeff - still got all your details for the EV charger at 670 London Road, three-phase, 2025 model, about 5m from the switchboard. Just need that photo of the charger spot to lock in the quote - sending the link now.",
    "No worries Jeff - sending that link through again now, just tap it to upload a photo of the charger spot and I'll get your quote sorted.",
    "Sorry about that Jeff, resending now - tap the link to upload a photo of the charger spot at 670 London Road and I'll get your quote sorted.",
  ]

  it.each(REPORTED)('removes the promise from a real failing message', (msg) => {
    const out = stripLinkPromise(msg)
    expect(out).not.toBe(msg)
    expect(out).not.toMatch(/sending (the|that) link|resending/i)
    expect(out.length).toBeGreaterThan(0)
  })

  it('leaves a reply that carries a REAL url completely alone', () => {
    const msg = 'Jeph, last thing - send a photo of the spot: https://x.dev/upload/abc'
    expect(stripLinkPromise(msg)).toBe(msg)
  })

  it('leaves ordinary replies untouched', () => {
    for (const msg of [
      "Cheers Jeph - what suburb's the job in?",
      'Good one - roughly how far is the parking spot from the switchboard?',
      'Righto - single-phase or three-phase supply?',
    ]) {
      expect(stripLinkPromise(msg)).toBe(msg)
    }
  })

  it('never returns an empty string — a blank SMS is worse than an over-promise', () => {
    expect(stripLinkPromise('Sending the link now.')).not.toBe('')
  })

  it('asks for the next step without promising unscheduled quote work when no useful clause remains', () => {
    expect(stripLinkPromise('Sending the link now.')).toBe(
      'I have not sent a link in this reply. What would you like help with next?',
    )
    expect(stripLinkPromise('Sending the link now.')).not.toMatch(/shortly|on (?:its|the) way|quote sorted|come back/i)
  })

  it('is a no-op on empty input', () => {
    expect(stripLinkPromise('')).toBe('')
  })

  it('keeps the useful half of the sentence', () => {
    const out = stripLinkPromise(
      "Beauty Jeph - I'll flick you a link for the photo. What suburb's the job in?",
    )
    expect(out).toContain('suburb')
    expect(out).not.toMatch(/flick you a link/i)
  })
})
