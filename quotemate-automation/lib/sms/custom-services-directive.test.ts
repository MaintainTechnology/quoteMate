// Migration 032 — the mandated-questions render. Proves a service with
// clarifying_questions gets a MUST-ASK block + the "no finish until
// answered" mandate, while a service without one keeps the exact legacy
// behaviour (universal name+suburb+scope only). The bound + scoping
// guards stop a huge custom catalogue blowing the prompt budget and stop
// inspection-only rows accidentally inheriting the quote questions.

import { describe, expect, it } from 'vitest'
import { TurnDecisionSchema, customServicesDirective, type CustomServiceScope } from './dialog'

const withQs: CustomServiceScope = {
  name: 'Install rainwater tank',
  description: 'Connect tank to downpipe + overflow',
  always_inspection: false,
  clarifying_questions: [
    'What size is the tank, and is it on a prepared base?',
    'Downpipe + overflow only, or also a pump / house connection?',
    'One tank, or more than one?',
  ],
}
const noQs: CustomServiceScope = {
  name: 'Install widget',
  description: 'Some service',
  always_inspection: false,
  clarifying_questions: null,
}

describe('customServicesDirective — mandated clarifying questions (mig 032)', () => {
  it('allows enabled tenant-service job types in the dialog decision schema', () => {
    for (const jobType of ['oven_cooktop', 'gas_fitting', 'cctv_inspection', 'prv_install']) {
      expect(() => TurnDecisionSchema.parse({
        action: 'ask',
        job_type_guess: jobType,
        reply_to_send: 'Got it - just checking one more detail.',
        assumptions_made: [],
        ready_for_intake: false,
        reason_for_escalation: null,
      })).not.toThrow()
    }
  })

  it('renders the questions + the no-finish-until-answered mandate', () => {
    const out = customServicesDirective([withQs])
    expect(out).toContain('Install rainwater tank')
    expect(out).toContain('MUST ASK before any finish (one per turn, in order):')
    expect(out).toContain('1. What size is the tank, and is it on a prepared base?')
    expect(out).toContain('3. One tank, or more than one?')
    // The mandate itself — must block finish/draft until answered.
    expect(out).toMatch(/REQUIRED\s+per-job fields/i)
    expect(out).toMatch(/BEFORE action='finish'/)
    expect(out).toMatch(/Do NOT finish,\s+draft/i) // wraps across lines
    // Still must NOT route these to inspection.
    expect(out).toMatch(/do NOT escalate to inspection/i)
  })

  it('overrides Rule 7 while answering, but keeps the anti-loop guard', () => {
    const out = customServicesDirective([withQs])
    // The mandated questions must beat the 4-turn "too many turns" cap
    // (the regression: long question sets were tripping Rule 7).
    expect(out).toMatch(/OVERRIDE Rule 7/i)
    expect(out).toMatch(/too many\s+turns/i)
    // ...but the conversation must still not be able to loop forever.
    expect(out).toMatch(/Rule 7\s+resume/i)
    expect(out).toMatch(/STOPS giving usable answers/i)
  })

  it('a service WITHOUT questions keeps the exact legacy behaviour', () => {
    const out = customServicesDirective([noQs])
    expect(out).toContain('Install widget')
    expect(out).not.toContain('MUST ASK before any finish')
  })

  it('mixed list: only the scripted service gets a MUST-ASK block', () => {
    const out = customServicesDirective([noQs, withQs])
    expect(out).toContain('Install widget')
    expect(out).toContain('Install rainwater tank')
    expect((out.match(/MUST ASK before any finish/g) ?? []).length).toBe(1)
  })

  it('bounds the questions per service (prompt-budget guard)', () => {
    const many: CustomServiceScope = {
      name: 'Big service',
      description: null,
      always_inspection: false,
      clarifying_questions: Array.from({ length: 12 }, (_, i) => `Q${i + 1}?`),
    }
    const out = customServicesDirective([many])
    expect(out).toContain('6. Q6?')
    expect(out).not.toContain('7. Q7?')
  })

  it('inspection-only rows do NOT inherit the quote questions', () => {
    const inspOnly: CustomServiceScope = {
      ...withQs,
      name: 'Switchboard upgrade',
      always_inspection: true,
    }
    const out = customServicesDirective([inspOnly])
    expect(out).toContain('Switchboard upgrade')
    expect(out).toContain('INSPECTION-ONLY')
    // Questions are a quote-path concern; an inspection-only row routes
    // to $99 and must not render a MUST-ASK block.
    expect(out).not.toContain('MUST ASK before any finish')
  })

  it('empty / undefined input → empty string (unchanged)', () => {
    expect(customServicesDirective(undefined)).toBe('')
    expect(customServicesDirective([])).toBe('')
  })

  it('Rule 6a exempts matched customAssemblies from outdoor/weatherproof auto-escalation (T013 fix 2026-05-21)', async () => {
    // The 21 May n8n sweep caught Rule 6a auto-escalating on "outdoor
    // weatherproof power point" before the customAssembly's MUST-ASK
    // questions could be asked. The exemption now lives in the static
    // SYSTEM_PROMPT (Rule 6a), not the per-call customServicesDirective.
    const { SYSTEM_PROMPT } = await import('./dialog')
    expect(SYSTEM_PROMPT).toMatch(/MATCHED-CUSTOMASSEMBLY EXEMPTION/i)
    // The whole point of the exemption:
    expect(SYSTEM_PROMPT).toMatch(/is NOT an escalation trigger/i)
    expect(SYSTEM_PROMPT).toContain('"Outdoor / weatherproof"')
    // Concrete example named so the model can pattern-match:
    expect(SYSTEM_PROMPT).toMatch(/Install outdoor IP-rated GPO/i)
    // The exemption must defer to the MATCHED row's questions, not bypass
    // them entirely — the answer to those questions may still justify
    // escalation.
    expect(SYSTEM_PROMPT).toMatch(/Only the answer to those[\s\S]+mandated questions can justify the escalation/i)
    // The pre-existing Rule 6a escalation triggers must still apply to
    // generic GPO requests (no matched customAssembly).
    expect(SYSTEM_PROMPT).toMatch(/no power nearby/i)
    expect(SYSTEM_PROMPT).toMatch(/new\/dedicated[\s\S]*?circuit/i)
  })

  it('HARD RULE override forbids escalate_inspection while MUST-ASK is pending (Cluster B fix 2026-05-20)', () => {
    // The sweep on 2026-05-20 showed the agent jumping straight to $99
    // inspection for EV charger / oven_cooktop / outdoor GPO / leak
    // detection / CCTV / PRV / gas appliance — all services that have
    // mandated questions in DB but were getting bypassed. The HARD RULE
    // makes the override explicit: MUST-ASK pending → action MUST be 'ask'.
    const out = customServicesDirective([withQs])
    expect(out).toMatch(/HARD RULE/i)
    expect(out).toMatch(/NEVER\s+set action='escalate_inspection' for a matched row/i)
    // The training-instinct categories the model was leaking on:
    expect(out).toMatch(/EV charger/i)
    expect(out).toMatch(/oven\/cooktop/i)
    expect(out).toMatch(/gas appliance/i)
    expect(out).toMatch(/CCTV/i)
    expect(out).toMatch(/PRV/i)
    expect(out).toMatch(/leak detection/i)
    // The escape clause — after MUST-ASKs are answered, escalation may
    // still be valid if the ANSWERS justify it.
    expect(out).toMatch(/Only AFTER every MUST-ASK is answered/i)
  })
})
