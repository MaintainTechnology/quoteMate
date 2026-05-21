// Phase 0 exit gate (admin bulk loader §12/§13) — SMS path.
//
// tradeScopeDirective() feeds the SMS dialog's user message. The pilot
// branches (electrical / plumbing / both / empty) are UNCHANGED code — the
// inline snapshots below pin them byte-for-byte so the Phase 0 type-widening
// cannot have altered what the live agent is told. The carpentry case
// verifies the §3 fix: a non-pilot trade now gets a real directive instead
// of the old degenerate "assume both pilots" fallback.

import { describe, it, expect } from 'vitest'
import { tradeScopeDirective } from './dialog'

describe('tradeScopeDirective — pilot trades unchanged (byte-identical pins)', () => {
  it('both trades', () => {
    expect(tradeScopeDirective(['electrical', 'plumbing']))
      .toMatchInlineSnapshot(`
        "TENANT TRADE SCOPE: this tradie covers BOTH electrical AND plumbing jobs.
          - All easy-5 job_types from both trades are valid:
              ELECTRICAL: downlights, power_points, ceiling_fans, smoke_alarms, outdoor_lighting
              PLUMBING  : blocked_drain, hot_water, tap_repair, tap_replace, toilet_repair, toilet_replace
          - Pick the right tradie noun ("sparky" for electrical jobs,
            "plumber" for plumbing jobs, generic "tradie" until job_type clear).
          - In the opener invite, mention BOTH trades:
              "We do electrical (downlights, GPOs, fans, smoke alarms, outdoor lights)
               AND plumbing (blocked drains, hot water, taps, toilets).""
      `)
  })

  it('electrical only', () => {
    expect(tradeScopeDirective(['electrical'])).toMatchInlineSnapshot(`
      "TENANT TRADE SCOPE: this tradie covers ELECTRICAL jobs ONLY. They do NOT do plumbing.
        - Valid easy-5 job_types: downlights, power_points, ceiling_fans, smoke_alarms, outdoor_lighting.
        - Always use "sparky" / "the sparkies" as the tradie noun. Never "plumber".
        - In the opener invite, mention ONLY electrical:
            "We do downlights, GPOs (power points), ceiling fans, smoke alarms, and outdoor lights."
        - If the customer mentions a PLUMBING job (blocked drain, hot water, tap, toilet, leak, pipe,
          gas, bathroom reno, drain camera): set action='end_conversation' with a polite redirect
          that makes it clear we only do electrical. Example:
            "Apologies <name>, we're sparkies - we don't do plumbing work.
             You'll need a plumber for that one. All the best!"
        - DO NOT escalate plumbing jobs to a $99 inspection. That's for out-of-scope ELECTRICAL
          work (switchboards, EV chargers, etc.), not for the wrong trade entirely."
    `)
  })

  it('plumbing only', () => {
    expect(tradeScopeDirective(['plumbing'])).toMatchInlineSnapshot(`
      "TENANT TRADE SCOPE: this tradie covers PLUMBING jobs ONLY. They do NOT do electrical.
        - Valid easy-5 job_types: blocked_drain, hot_water, tap_repair, tap_replace, toilet_repair, toilet_replace.
        - Always use "plumber" / "the plumbers" as the tradie noun. Never "sparky".
        - In the opener invite, mention ONLY plumbing:
            "We do blocked drains, hot water systems, tap repairs/replacements, and toilet repairs/replacements."
        - If the customer mentions an ELECTRICAL job (downlights, GPO, power point, ceiling fan, smoke alarm,
          outdoor light, switchboard, EV charger): set action='end_conversation' with a polite redirect
          that makes it clear we only do plumbing. Example:
            "Apologies <name>, we're plumbers - we don't do electrical work.
             You'll need a sparky for that one. All the best!"
        - DO NOT escalate electrical jobs to a $99 inspection. That's for out-of-scope PLUMBING
          work (gas fitting, bathroom reno, etc.), not for the wrong trade entirely."
    `)
  })

  it('undefined → permissive "both" (legacy pre-v6 default)', () => {
    expect(tradeScopeDirective(undefined)).toBe(
      tradeScopeDirective(['electrical', 'plumbing']),
    )
  })

  it('empty array → degenerate "unknown" fallback', () => {
    expect(tradeScopeDirective([])).toBe(
      'TENANT TRADE SCOPE: unknown — proceed as if both trades are supported. (Audit: tenant.trades was empty.)',
    )
  })
})

describe('tradeScopeDirective — non-pilot trade (§3 fix)', () => {
  it('a brand-new trade gets a real directive, not the "both pilots" fallback', () => {
    const directive = tradeScopeDirective(['carpentry'])
    expect(directive).toContain('this tradie covers carpentry work')
    expect(directive).toContain('TENANT CUSTOM')
    // It must NOT wrongly claim the electrical/plumbing pilot scope.
    expect(directive).not.toContain('downlights')
    expect(directive).not.toContain('blocked_drain')
    expect(directive).not.toContain('proceed as if both trades')
  })

  it('multiple non-pilot trades are named together', () => {
    expect(tradeScopeDirective(['carpentry', 'tiling'])).toContain(
      'this tradie covers carpentry and tiling work',
    )
  })
})
