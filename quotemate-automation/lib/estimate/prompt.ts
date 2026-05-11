// Estimator system-prompt router.
//
// v5 (multi-trade — see docs/strategy.md) split the single electrical prompt
// into two trade-specific modules. This file is the router: it picks the
// correct prompt based on intake.trade. Callers should import `systemPrompt`
// from here, NOT from electrical-prompt.ts / plumbing-prompt.ts directly.

import { electricalSystemPrompt } from './electrical-prompt'
import { plumbingSystemPrompt } from './plumbing-prompt'

type PricingBook = {
  hourly_rate: number;
  call_out_minimum: number;
  apprentice_rate: number;
  default_markup_pct: number;
  risk_buffer_pct: number;
  min_labour_hours?: number;
  gst_registered: boolean;
  licence_type: string | null;
  licence_state: string | null;
}

type IntakeForRouting = {
  trade?: 'electrical' | 'plumbing' | string | null
}

export function systemPrompt(intake: IntakeForRouting, pricingBook: PricingBook): string {
  // Default to electrical for legacy intake rows that pre-date v5 and
  // have no trade column populated. The intake structurer (voice path)
  // also defaults trade='electrical' explicitly — see lib/intake/structure.ts.
  if (intake?.trade === 'plumbing') {
    return plumbingSystemPrompt(pricingBook)
  }
  return electricalSystemPrompt(pricingBook)
}
