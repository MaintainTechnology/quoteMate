// Estimator system-prompt router — data-driven (admin bulk loader, Phase 0).
//
// Before: a binary `if plumbing … else electrical` over two hand-written
// prompt modules. After: the prompt text is DATA. systemPrompt() loads the
// trade's `trade_prompts.estimator_system_prompt` template from the DB and
// renders it through the prompt-template engine — so a NEW trade added by
// the admin loader (docs/admin-bulk-loader-spec.md) needs no code change here.
//
// SAFETY — electrical and plumbing can never break:
//   1. DB `trade_prompts` row (primary).
//   2. the bundled template constant (DB unavailable / row missing).
//   3. the hand-written oracle module (template missing / render error).
// The prompt-parity test proves the bundled templates render byte-identical
// to electricalSystemPrompt()/plumbingSystemPrompt(), so every path above
// produces exactly today's system prompt for the two pilot trades.
//
// Callers import `systemPrompt` from here, NOT electrical-prompt.ts /
// plumbing-prompt.ts directly.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { electricalSystemPrompt } from './electrical-prompt'
import { plumbingSystemPrompt } from './plumbing-prompt'
import { renderPromptTemplate } from '@/lib/prompt-template/render'
import { buildEstimatorContext, type EstimatorPricingBook } from './prompt-context'
import { ELECTRICAL_ESTIMATOR_TEMPLATE } from './prompt-templates/electrical-estimator'
import { PLUMBING_ESTIMATOR_TEMPLATE } from './prompt-templates/plumbing-estimator'

export type PricingBook = EstimatorPricingBook

type IntakeForRouting = {
  trade?: 'electrical' | 'plumbing' | string | null
}

// Bundled estimator templates for the two pilot trades. These are both the
// fallback when the DB read fails AND the seed the backfill script copies
// into `trade_prompts`. The prompt-parity test pins them byte-identical to
// the oracle modules below.
const BUNDLED_ESTIMATOR_TEMPLATES: Record<string, string> = {
  electrical: ELECTRICAL_ESTIMATOR_TEMPLATE,
  plumbing: PLUMBING_ESTIMATOR_TEMPLATE,
}

// Hand-written oracle modules — last-resort fallback if even the bundled
// template fails to render. Unknown trades default to electrical, exactly
// as the pre-Phase-0 binary router did.
const ESTIMATOR_ORACLES: Record<
  string,
  (book: EstimatorPricingBook) => string
> = {
  electrical: electricalSystemPrompt,
  plumbing: plumbingSystemPrompt,
}

// Lazy, memoised service-role client. Created on first DB read, not at
// module load — so importing this module (e.g. in a unit test) needs no
// Supabase env vars, and a missing env just routes to the bundled fallback.
let _client: SupabaseClient | null = null
function getClient(): SupabaseClient | null {
  if (_client) return _client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  _client = createClient(url, key)
  return _client
}

function normaliseTrade(intake: IntakeForRouting): string {
  const t = intake?.trade
  // Legacy pre-v5 intakes have no trade column — default to electrical, the
  // same default the intake structurer (voice path) writes explicitly.
  if (typeof t === 'string' && t.trim() !== '') return t
  return 'electrical'
}

/** Load a trade's estimator prompt template from `trade_prompts`. Returns
 *  null on any failure (no client, no row, empty text) so the caller falls
 *  back to the bundled template. */
async function loadEstimatorTemplate(trade: string): Promise<string | null> {
  const client = getClient()
  if (!client) return null
  const { data, error } = await client
    .from('trade_prompts')
    .select('estimator_system_prompt, trades!inner(name)')
    .eq('trades.name', trade)
    .maybeSingle()
  if (error || !data) return null
  const tpl = (data as { estimator_system_prompt?: string | null })
    .estimator_system_prompt
  return tpl && tpl.trim() !== '' ? tpl : null
}

/**
 * Render the estimator system prompt for a trade. Pure and synchronous —
 * the DB read happens in systemPrompt(); this is the part the prompt-parity
 * test exercises without a database.
 *
 * @param dbTemplate the trade_prompts template text, or null/undefined to
 *                    use the bundled template (then the oracle module).
 */
export function renderEstimatorSystemPrompt(
  trade: string,
  pricingBook: EstimatorPricingBook,
  dbTemplate?: string | null,
): string {
  const template =
    dbTemplate && dbTemplate.trim() !== ''
      ? dbTemplate
      : (BUNDLED_ESTIMATOR_TEMPLATES[trade] ?? null)

  if (template) {
    try {
      return renderPromptTemplate(
        template,
        buildEstimatorContext(trade, pricingBook),
      )
    } catch {
      // A malformed template must never block a quote — fall through to the
      // hand-written oracle module.
    }
  }

  const oracle = ESTIMATOR_ORACLES[trade] ?? electricalSystemPrompt
  return oracle(pricingBook)
}

/**
 * The estimator system prompt for an intake. Loads the trade's
 * `trade_prompts` template, renders it, and falls back through the bundled
 * template and the oracle module so electrical/plumbing always quote.
 *
 * Tenant brand preferences (migration 022) are NOT injected here — they live
 * in the per-call user prompt via buildPreferencesBlock() in run.ts, which
 * keeps this system prompt identical across tenants so the Anthropic
 * ephemeral prompt cache stays warm.
 */
export async function systemPrompt(
  intake: IntakeForRouting,
  pricingBook: EstimatorPricingBook,
): Promise<string> {
  const trade = normaliseTrade(intake)
  let dbTemplate: string | null = null
  try {
    dbTemplate = await loadEstimatorTemplate(trade)
  } catch {
    // DB unavailable — render from the bundled template instead.
  }
  return renderEstimatorSystemPrompt(trade, pricingBook, dbTemplate)
}
