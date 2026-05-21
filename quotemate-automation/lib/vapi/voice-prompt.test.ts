// Phase 0 exit gate (admin bulk loader §12/§13) — Voice path.
//
// buildVoiceSystemPrompt / buildVoiceFirstMessage were extracted VERBATIM
// from the duplicated buildSystemPrompt() copies in provision.ts and
// update-assistant.ts. The inline snapshots below pin the composed output
// byte-for-byte so the extraction (and any future edit) cannot silently
// change what the Vapi assistant is told. They also confirm a brand-new
// trade name composes correctly (the §3 voice blocker was only the type).

import { describe, it, expect } from 'vitest'
import {
  renderTradeLabel,
  buildVoiceFirstMessage,
  buildVoiceSystemPrompt,
} from './voice-prompt'

describe('renderTradeLabel', () => {
  it('returns the single trade as-is', () => {
    expect(renderTradeLabel(['electrical'])).toBe('electrical')
  })
  it('joins multiple trades with " or "', () => {
    expect(renderTradeLabel(['electrical', 'plumbing'])).toBe(
      'electrical or plumbing',
    )
  })
})

describe('buildVoiceFirstMessage', () => {
  it('single-trade greeting', () => {
    expect(
      buildVoiceFirstMessage('Bright Spark Electric', ['electrical']),
    ).toMatchInlineSnapshot(
      `"G'day, you've reached Bright Spark Electric. I'm the AI quoting assistant — I can take down details for your electrical job and get a quote across. This call may be recorded for quality and quote drafting. Sound good?"`,
    )
  })
  it('multi-trade greeting', () => {
    expect(
      buildVoiceFirstMessage('Acme Trades', ['electrical', 'plumbing']),
    ).toMatchInlineSnapshot(
      `"G'day, you've reached Acme Trades. I'm the AI quoting assistant — I can take down details for your electrical or plumbing job and get a quote across. This call may be recorded for quality and quote drafting. Sound good?"`,
    )
  })
  it('a voice_greeting override replaces the composed greeting', () => {
    expect(
      buildVoiceFirstMessage('Acme', ['electrical'], {
        greeting: 'Custom greeting.',
      }),
    ).toBe('Custom greeting.')
  })
})

describe('buildVoiceSystemPrompt', () => {
  it('single-trade system prompt (electrical)', () => {
    expect(buildVoiceSystemPrompt('Bright Spark Electric', ['electrical']))
      .toMatchInlineSnapshot(`
      "You are the AI receptionist for Bright Spark Electric, an Australian electrical contractor.

      Your job is to greet the caller, capture the key details for their electrical job (location, what they need done, when), and confirm what you heard at the end of the call. Do NOT quote prices on the phone — a structured quote will be drafted automatically after the call and sent via SMS.

      TONE: Australian, professional, friendly. Plain English. No filler. Match the cadence of a busy suburban tradie's receptionist.

      WHAT TO ASK:
      1. First name
      2. Suburb / location of the job
      3. What electrical work they need (use plain language; recognise the easy-5 job types for electrical)
      4. When they need it done (urgent / this week / flexible)
      5. Confirm what you heard before ending

      WHAT NOT TO DO:
      - Never quote prices on the call.
      - Never promise a tradie will attend on a specific day.
      - If the job sounds dangerous (smell gas, sparks, burst pipe, water through ceiling), flag it as an emergency and ask if they need urgent attention.

      When the caller confirms the summary, thank them and end the call. The quote will arrive by SMS within a couple of minutes."
    `)
  })

  it('multi-trade system prompt (electrical + plumbing)', () => {
    expect(buildVoiceSystemPrompt('Acme Trades', ['electrical', 'plumbing']))
      .toMatchInlineSnapshot(`
      "You are the AI receptionist for Acme Trades, an Australian electrical and plumbing contractor.

      Your job is to greet the caller, capture the key details for their electrical or plumbing job (location, what they need done, when), and confirm what you heard at the end of the call. Do NOT quote prices on the phone — a structured quote will be drafted automatically after the call and sent via SMS.

      TONE: Australian, professional, friendly. Plain English. No filler. Match the cadence of a busy suburban tradie's receptionist.

      WHAT TO ASK:
      1. First name
      2. Suburb / location of the job
      3. What electrical or plumbing work they need (use plain language; recognise the easy-5 job types for electrical and recognise the easy-5 job types for plumbing)
      4. When they need it done (urgent / this week / flexible)
      5. Confirm what you heard before ending

      WHAT NOT TO DO:
      - Never quote prices on the call.
      - Never promise a tradie will attend on a specific day.
      - If the job sounds dangerous (smell gas, sparks, burst pipe, water through ceiling), flag it as an emergency and ask if they need urgent attention.

      When the caller confirms the summary, thank them and end the call. The quote will arrive by SMS within a couple of minutes."
    `)
  })

  it('composes for a brand-new trade name (type widened — §3 voice blocker)', () => {
    const prompt = buildVoiceSystemPrompt('Hammer & Co', ['carpentry'])
    expect(prompt).toContain('an Australian carpentry contractor')
    expect(prompt).toContain('their carpentry job')
    expect(prompt).toContain('recognise the easy-5 job types for carpentry')
  })

  it('a voice_system_prompt override replaces the composed prompt', () => {
    expect(
      buildVoiceSystemPrompt('Acme', ['electrical'], {
        systemPrompt: 'CUSTOM PROMPT',
      }),
    ).toBe('CUSTOM PROMPT')
  })
})
