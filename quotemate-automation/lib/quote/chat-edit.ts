// AI chat-edit core — translate a tradie's plain-English instruction into a
// PROPOSED edit of an existing quote's Good/Better/Best line items.
//
// This module ONLY proposes. It never writes to the DB, never calls Stripe,
// never renders a PDF, and never sends an SMS. The route that calls it
// (app/api/quote/[id]/chat-edit/route.ts) hands the proposal to the client,
// which — on the tradie's explicit Save — POSTs it to the UNCHANGED
// app/api/quote/[id]/edit endpoint that does the actual grounded write.
//
// Money safety (spec R6): a quote is legally binding and carries live Stripe
// links, so the AI must never emit a free-form price. The `grounded` flag on
// every diff line is NOT the model's say-so — it is computed by re-running the
// SAME validateQuoteGrounding + detectCrossTierDuplicates gate the edit
// endpoint enforces, against the SAME catalogue candidates. A line the
// validator would reject is returned grounded:false so the UI can flag it and
// the tradie can correct it (or consciously force it through /edit).
//
// Pure core + thin IO (mirrors lib/estimation/refine.ts):
//   • parseProposal / buildEditDiff / ungroundedKeys / tierChanged — pure, tested
//   • proposeQuoteEdit (generateText + tools) — thin IO

import { anthropic } from '@ai-sdk/anthropic'
import { generateText, stepCountIs } from 'ai'
import { makeTools } from '@/lib/estimate/tools'
import { finiteQuoteNumber } from './numeric-input'
import {
  validateQuoteGrounding,
  detectCrossTierDuplicates,
  MANUAL_LINE_SOURCE,
  type PricingBookForValidation,
  type CandidatePrices,
  type GroundingFailure,
} from '@/lib/estimate/validate'

// Same model the estimator drafts with (lib/estimate/run.ts). Money-touching
// steps stay on the Opus tier — grounded pricing over latency.
export const CHAT_EDIT_MODEL = 'claude-opus-4-8'

export type TierKey = 'good' | 'better' | 'best'
export const TIER_KEYS: TierKey[] = ['good', 'better', 'best']

export type ChatEditLineItem = {
  original_line_index?: number
  description: string
  quantity: number
  unit?: string
  unit_price_ex_gst: number
  source?: string
  supplied_by?: 'tradie' | 'customer'
  safety_note?: string
}

export type ChatEditTier = {
  label: string
  timeframe?: string
  line_items: ChatEditLineItem[]
} | null

// A tier present here = "the AI changed it". A tier absent (undefined) = left
// untouched. Mirrors the body shape POST /api/quote/[id]/edit already accepts.
export type ChatEditTiers = {
  good?: ChatEditTier
  better?: ChatEditTier
  best?: ChatEditTier
}

export type DiffEntry = {
  tier: TierKey
  op: 'add' | 'remove' | 'change'
  description: string
  oldQuantity?: number
  newQuantity?: number
  oldUnitPriceExGst?: number
  newUnitPriceExGst?: number
  /** false when validateQuoteGrounding would reject this proposed line. */
  grounded: boolean
  reason?: string
}

export type ProposeResult = {
  assistantMessage: string
  proposedTiers: ChatEditTiers
  diff: DiffEntry[]
  anyUngrounded: boolean
}

// ── Pure: numeric + text helpers ──────────────────────────────────────

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}

function normDesc(s: string): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// ── Pure: parse the model's JSON reply ────────────────────────────────

/** Tolerant extraction of the assistant's `{ message, tiers }` reply.
 *  Mirrors the lenient JSON handling in lib/estimate (match the first
 *  brace-balanced object, ignore prose around it). Never throws. `found` is
 *  false when no JSON object could be parsed at all — the route maps that to a
 *  502 ("couldn't draft a change"), distinct from a valid-but-empty proposal
 *  (a clarifying question), which is a normal 200. */
export function parseProposal(text: string): { found: boolean; message: string; tiers: ChatEditTiers } {
  const match = (text ?? '').match(/\{[\s\S]*\}/)
  if (!match) return { found: false, message: '', tiers: {} }
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    return { found: false, message: '', tiers: {} }
  }
  const message = typeof obj.message === 'string' ? obj.message : ''
  const rawTiers =
    obj.tiers && typeof obj.tiers === 'object' ? (obj.tiers as Record<string, unknown>) : obj
  const tiers: ChatEditTiers = {}
  for (const k of TIER_KEYS) {
    if (!(k in rawTiers)) continue
    const t = rawTiers[k]
    if (t === null) {
      tiers[k] = null
      continue
    }
    if (!t || typeof t !== 'object') continue
    const tt = t as Record<string, unknown>
    const items = Array.isArray(tt.line_items) ? tt.line_items : []
    if (items.some((li) => !li || typeof li !== 'object' ||
        typeof li.description !== 'string' || !li.description.trim() ||
        finiteQuoteNumber(li.quantity) === null || finiteQuoteNumber(li.unit_price_ex_gst) === null ||
        finiteQuoteNumber(li.quantity)! < 0 || finiteQuoteNumber(li.unit_price_ex_gst)! < 0)) {
      return { found: false, message: '', tiers: {} }
    }
    if (items.some((li) => li && typeof li === 'object' && 'original_line_index' in li &&
        (!Number.isSafeInteger(li.original_line_index) || li.original_line_index < 0))) {
      return { found: false, message: '', tiers: {} }
    }
    const line_items: ChatEditLineItem[] = items
      .filter((li): li is Record<string, unknown> => !!li && typeof li === 'object')
      .map((li) => ({
        ...(typeof li.original_line_index === 'number' ? { original_line_index: li.original_line_index } : {}),
        description: String(li.description ?? '').trim(),
        quantity: finiteQuoteNumber(li.quantity)!,
        unit: li.unit != null ? String(li.unit) : undefined,
        unit_price_ex_gst: finiteQuoteNumber(li.unit_price_ex_gst)!,
        ...(li.source != null && String(li.source).trim() ? { source: String(li.source) } : {}),
      }))
      .filter(
        (li) =>
          li.description.length > 0 &&
          Number.isFinite(li.quantity) &&
          Number.isFinite(li.unit_price_ex_gst),
      )
    tiers[k] = {
      label: String(tt.label ?? `${k} option`),
      timeframe: tt.timeframe != null && String(tt.timeframe).trim() ? String(tt.timeframe) : undefined,
      line_items,
    }
  }
  return { found: true, message, tiers }
}

// ── Pure: source-provenance reconciliation ────────────────────────────

/** Resolve the `source` of a proposed line so grounding behaves correctly:
 *   • a line matching an existing line (by normalised description) INHERITS that
 *     line's source — so a kept/edited `tradie_manual` custom line stays exempt
 *     and a `material:<id>`/`assembly:<id>` strict anchor survives the edit;
 *   • a genuinely new line keeps the model's source, EXCEPT the manual sentinel
 *     (`tradie_manual`) is rewritten to `tradie_edit` so the model can't inject
 *     a grounding-exempt free-form price (R6). */
export function reconcileLineSource(
  proposed: ChatEditLineItem,
  currentLines: ChatEditLineItem[] | undefined,
): string | undefined {
  const match = currentLineForProposal(proposed, currentLines)
  if (match?.source) return match.source
  const s = (proposed.source ?? '').trim().toLowerCase()
  if (s === MANUAL_LINE_SOURCE) return 'tradie_edit'
  return proposed.source
}

function currentLineForProposal(proposed: ChatEditLineItem, lines: ChatEditLineItem[] = []) {
  const matches = proposed.original_line_index !== undefined
    ? lines.filter((line) => line.original_line_index === proposed.original_line_index)
    : lines.filter((line) => normDesc(line.description) === normDesc(proposed.description))
  if (matches.length > 1 || (proposed.original_line_index !== undefined && matches.length !== 1)) {
    throw new Error('ambiguous_line_provenance')
  }
  return matches[0]
}

/** Apply reconcileLineSource across a proposed tier's line items. */
export function reconcileTierSources(
  proposed: ChatEditTier,
  current: ChatEditTier | undefined,
): ChatEditTier {
  if (!proposed) return proposed
  const indices = proposed.line_items.flatMap((line) => line.original_line_index === undefined ? [] : [line.original_line_index])
  if (new Set(indices).size !== indices.length) throw new Error('duplicate_line_identity')
  return {
    ...proposed,
    line_items: proposed.line_items.map((li) => {
      const source = reconcileLineSource(li, current?.line_items)
      const original = currentLineForProposal(li, current?.line_items)
      const next: ChatEditLineItem = {
        description: li.description,
        quantity: li.quantity,
        unit: li.unit,
        unit_price_ex_gst: li.unit_price_ex_gst,
      }
      if (original?.original_line_index !== undefined) next.original_line_index = original.original_line_index
      if (original?.supplied_by !== undefined) next.supplied_by = original.supplied_by
      if (original?.safety_note !== undefined) next.safety_note = original.safety_note
      if (source) next.source = source
      return next
    }),
  }
}

// ── Pure: which proposed lines are ungrounded ─────────────────────────

/** Build the set of "tier:lineIndex" keys that fail grounding — from the
 *  validator's per-line failures plus any cross-tier-duplicate occurrences
 *  that land inside a proposed tier. The edit endpoint enforces both gates,
 *  so the preview marks both. */
export function ungroundedKeys(
  failures: GroundingFailure[],
  crossTierOccurrences: Array<{ tier: TierKey; lineIndex: number }>,
): Set<string> {
  const keys = new Set<string>()
  for (const f of failures) keys.add(`${f.tier}:${f.lineIndex}`)
  for (const c of crossTierOccurrences) keys.add(`${c.tier}:${c.lineIndex}`)
  return keys
}

// ── Pure: did a tier actually change? ─────────────────────────────────

/** True when the proposed tier differs from the current one in label,
 *  timeframe, or any line (description / quantity / unit / price). Used to
 *  prune untouched tiers out of the proposal so /edit only re-issues Stripe
 *  links for tiers that really moved. A null↔non-null transition counts as a
 *  change. */
export function tierChanged(current: ChatEditTier | undefined, proposed: ChatEditTier): boolean {
  if (!current || !proposed) return current !== proposed
  if ((current.label ?? '') !== (proposed.label ?? '')) return true
  if ((current.timeframe ?? '') !== (proposed.timeframe ?? '')) return true
  const a = current.line_items ?? []
  const b = proposed.line_items ?? []
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) {
    if (normDesc(a[i].description) !== normDesc(b[i].description)) return true
    if (round2(a[i].quantity) !== round2(b[i].quantity)) return true
    if (round2(a[i].unit_price_ex_gst) !== round2(b[i].unit_price_ex_gst)) return true
    if ((a[i].unit ?? '') !== (b[i].unit ?? '')) return true
  }
  return false
}

// ── Pure: human-readable diff ─────────────────────────────────────────

/** Compare current vs proposed tiers line-by-line and emit add/remove/change
 *  entries. Lines are matched by normalised description; a description present
 *  in both with a different qty/price is a `change`, only-in-proposed is an
 *  `add`, only-in-current is a `remove`. `grounded` is read off the
 *  `ungrounded` set keyed by "tier:proposedLineIndex". Tiers absent from
 *  `proposed` (untouched) produce no entries. */
export function buildEditDiff(
  current: ChatEditTiers,
  proposed: ChatEditTiers,
  ungrounded: Set<string>,
): DiffEntry[] {
  const diff: DiffEntry[] = []
  for (const tier of TIER_KEYS) {
    if (!(tier in proposed)) continue // tier untouched by the proposal
    const prop = proposed[tier]
    const cur = current[tier]
    const curLines = cur?.line_items ?? []
    const propLines = prop?.line_items ?? []

    const curByDesc = new Map<string, number>()
    curLines.forEach((li, idx) => {
      const k = normDesc(li.description)
      if (!curByDesc.has(k)) curByDesc.set(k, idx)
    })
    const matchedCur = new Set<number>()

    propLines.forEach((li, idx) => {
      const k = normDesc(li.description)
      const isUngrounded = ungrounded.has(`${tier}:${idx}`)
      const reason = isUngrounded
        ? 'Price not found in this tenant’s catalogue or pricing book.'
        : undefined
      const curIdx = curByDesc.get(k)
      if (curIdx !== undefined && !matchedCur.has(curIdx)) {
        matchedCur.add(curIdx)
        const match = curLines[curIdx]
        const qtyChanged = round2(match.quantity) !== round2(li.quantity)
        const priceChanged = round2(match.unit_price_ex_gst) !== round2(li.unit_price_ex_gst)
        if (qtyChanged || priceChanged) {
          diff.push({
            tier,
            op: 'change',
            description: li.description,
            oldQuantity: match.quantity,
            newQuantity: li.quantity,
            oldUnitPriceExGst: match.unit_price_ex_gst,
            newUnitPriceExGst: li.unit_price_ex_gst,
            grounded: !isUngrounded,
            ...(reason ? { reason } : {}),
          })
        }
        // identical line → no diff entry
      } else {
        diff.push({
          tier,
          op: 'add',
          description: li.description,
          newQuantity: li.quantity,
          newUnitPriceExGst: li.unit_price_ex_gst,
          grounded: !isUngrounded,
          ...(reason ? { reason } : {}),
        })
      }
    })

    curLines.forEach((li, idx) => {
      if (matchedCur.has(idx)) return
      diff.push({
        tier,
        op: 'remove',
        description: li.description,
        oldQuantity: li.quantity,
        oldUnitPriceExGst: li.unit_price_ex_gst,
        grounded: true, // removing a line can never be ungrounded
      })
    })
  }
  return diff
}

// ── Pure: prompt construction ─────────────────────────────────────────

export function buildSystemPrompt(
  trade: string,
  markupPct: number | string,
  groundingMode: 'catalogue' | 'tradie-authored' = 'catalogue',
): string {
  const pricingRules =
    groundingMode === 'catalogue'
      ? `HARD RULES — money safety:
- This quote is legally binding and carries live payment links. NEVER invent a price. Every unit_price_ex_gst you output MUST come from one of:
  (a) a price returned by the lookupAssembly or lookupMaterial tools,
  (b) the tenant's pricing_book labour rate (hourly_rate / apprentice_rate / senior_rate) for labour lines,
  (c) a line already present on the quote (when you keep or simply move it).
  For materials, run applyMarkup with markupPct = ${markupPct} on the looked-up base price.
- ALWAYS pass trade: "${trade}" to the lookup tools.`
      : `PRICING — this is a ${trade} quote with NO fixed price catalogue. The prices on this quote are the tradie's own (from their ${trade} estimator):
- Keep every existing line's price EXACTLY as-is unless the tradie explicitly asks to change that price.
- When the tradie specifies a price or quantity, use the number they give.
- When they ask to add an item without a price, propose a sensible price based on the existing lines and clearly describe it — the tradie reviews and approves every change before it saves.
- Do NOT call the lookup tools (this trade has no catalogue).`

  return `You are QuoteMax's quote-editing assistant for a licensed Australian ${trade} tradie. You edit an EXISTING, already-priced quote with up to three pricing tiers (good / better / best). The tradie tells you in plain English how to change it.

${pricingRules}
- Change ONLY what the instruction asks for. Keep every other line item exactly as it is.
- Every tier must keep at least one line item — never empty a tier.
- If the instruction is ambiguous or needs information you don't have, do not guess: return an empty "tiers" object and use "message" to ask the tradie one clarifying question.

OUTPUT — return ONLY a JSON object, no prose outside it:
{
  "message": "<one or two plain-English sentences summarising the change, OR a clarifying question>",
  "tiers": {
    "<only the tiers you changed>": {
      "label": "<tier label>",
      "timeframe": "<optional, e.g. '1-2 days'>",
      "line_items": [
        { "description": "...", "quantity": <number>, "unit": "<e.g. ea, hr>", "unit_price_ex_gst": <number>, "source": "<assembly|material|labour|tradie_edit>" }
      ]
    }
  }
}
Include a tier in "tiers" ONLY if you changed it; omit tiers you did not touch. For each changed tier, line_items must be the COMPLETE list for that tier (all kept lines plus your changes), not just the delta. Preserve original_line_index on every existing line even if you rename, reorder or change it. Omit original_line_index for genuinely new lines. Never invent an index or copy one index to multiple lines. Supplier and safety provenance belongs to the stored line; do not invent or alter it.`
}

export function buildUserPrompt(
  instruction: string,
  currentTiers: ChatEditTiers,
  pricingBook: PricingBookForValidation,
  trade: string,
): string {
  const book = {
    hourly_rate: pricingBook.hourly_rate,
    apprentice_rate: pricingBook.apprentice_rate,
    senior_rate: pricingBook.senior_rate ?? null,
    call_out_minimum: pricingBook.call_out_minimum,
    default_markup_pct: pricingBook.default_markup_pct,
    min_labour_hours: pricingBook.min_labour_hours ?? null,
  }
  return `trade: ${trade}
pricing_book: ${JSON.stringify(book)}

CURRENT QUOTE TIERS:
${JSON.stringify(currentTiers, null, 2)}

TRADIE INSTRUCTION:
${instruction}`
}

// ── IO: the proposal pass ─────────────────────────────────────────────

/** Run the AI translation, then GROUND-CHECK the result with the same gate
 *  the edit endpoint enforces, and return the proposal + a per-line diff.
 *  Throws on a model/parse failure (the route maps that to a 502). */
export async function proposeQuoteEdit(args: {
  instruction: string
  currentTiers: ChatEditTiers
  trade: string
  tenantId: string | null
  pricingBook: PricingBookForValidation
  candidates: CandidatePrices
  /** 'catalogue' (electrical/plumbing) runs the grounding validator;
   *  'tradie-authored' (solar/roof/paint) skips it — the tradie owns the
   *  prices. Defaults to catalogue (the safe gate). */
  groundingMode?: 'catalogue' | 'tradie-authored'
  scopeOfWorks?: string | null
  assumptions?: unknown
  model?: string
}): Promise<ProposeResult> {
  const {
    instruction,
    currentTiers,
    trade,
    tenantId,
    pricingBook,
    candidates,
    groundingMode = 'catalogue',
    scopeOfWorks = null,
    assumptions = null,
    model = CHAT_EDIT_MODEL,
  } = args

  // Catalogue-lookup tools only — no inspection escape on an edit path.
  const allTools = makeTools(tenantId)
  const tools = {
    lookupAssembly: allTools.lookupAssembly,
    lookupMaterial: allTools.lookupMaterial,
    applyMarkup: allTools.applyMarkup,
  }

  const result = await generateText({
    model: anthropic(model),
    messages: [
      { role: 'system', content: buildSystemPrompt(trade, pricingBook.default_markup_pct, groundingMode) },
      { role: 'user', content: buildUserPrompt(instruction, currentTiers, pricingBook, trade) },
    ],
    tools,
    stopWhen: stepCountIs(10),
    maxRetries: 0,
  })

  const { found, message, tiers: rawProposed } = parseProposal(result.text)
  // No parseable JSON at all → the model failed to produce a proposal. Throw so
  // the route returns a 502 ("couldn't draft a change"), distinct from a
  // valid-but-empty proposal (a clarifying question), which is a normal 200.
  if (!found) throw new Error('no_parseable_proposal')

  // Reconcile source provenance, drop empty-tier proposals, and prune unchanged
  // tiers so the apply step only re-validates / re-issues Stripe for tiers that
  // actually moved.
  const proposedTiers: ChatEditTiers = {}
  for (const k of TIER_KEYS) {
    if (!(k in rawProposed)) continue
    const reconciled = reconcileTierSources(rawProposed[k] as ChatEditTier, currentTiers[k])
    // A tier can never be emptied (the edit schema requires >=1 line item), so
    // drop an empty-line proposal rather than previewing an impossible save.
    if (reconciled && reconciled.line_items.length === 0) continue
    if (tierChanged(currentTiers[k], reconciled)) proposedTiers[k] = reconciled
  }

  // Nothing changed (e.g. the model asked a clarifying question) → empty diff.
  if (Object.keys(proposedTiers).length === 0) {
    return {
      assistantMessage: message || 'No change proposed.',
      proposedTiers: {},
      diff: [],
      anyUngrounded: false,
    }
  }

  // Grounding only applies to catalogue trades (electrical/plumbing). For
  // tradie-authored trades (solar/roof/paint) there's no catalogue to ground
  // against — the tradie owns the prices — so the gate is skipped and nothing
  // is flagged ungrounded. The /edit endpoint applies the same per-trade rule
  // on Save.
  let ungrounded = new Set<string>()
  if (groundingMode === 'catalogue') {
    // Per-tier grounding: validate ONLY the changed tiers (untouched tiers were
    // already grounded at draft/last-edit time), exactly like /edit's editedDraft.
    const editedDraft = {
      good: 'good' in proposedTiers ? proposedTiers.good : null,
      better: 'better' in proposedTiers ? proposedTiers.better : null,
      best: 'best' in proposedTiers ? proposedTiers.best : null,
    }
    const perTier = validateQuoteGrounding(editedDraft, pricingBook, candidates)
    const failures: GroundingFailure[] = perTier.valid ? [] : perTier.failures

    // Cross-tier duplicate check sees the FULL merged tier set (proposed over
    // current), matching what /edit checks on Save. Only occurrences that land
    // inside a proposed tier are markable in this preview.
    const merged = {
      scope_of_works: scopeOfWorks,
      scope_short: null,
      assumptions,
      good: 'good' in proposedTiers ? proposedTiers.good : (currentTiers.good ?? null),
      better: 'better' in proposedTiers ? proposedTiers.better : (currentTiers.better ?? null),
      best: 'best' in proposedTiers ? proposedTiers.best : (currentTiers.best ?? null),
    }
    let crossTierOccurrences: Array<{ tier: TierKey; lineIndex: number }> = []
    try {
      const dups = detectCrossTierDuplicates(merged, candidates)
      crossTierOccurrences = dups
        .flatMap((d) => d.occurrences)
        .filter((o) => o.tier in proposedTiers)
        .map((o) => ({ tier: o.tier as TierKey, lineIndex: o.lineIndex }))
    } catch {
      // A cross-tier check failure must never block the preview — the edit
      // endpoint runs the authoritative gate again on Save.
      crossTierOccurrences = []
    }
    ungrounded = ungroundedKeys(failures, crossTierOccurrences)
  }

  const diff = buildEditDiff(currentTiers, proposedTiers, ungrounded)

  return {
    assistantMessage: message || 'Proposed the change below.',
    proposedTiers,
    diff,
    anyUngrounded: ungrounded.size > 0,
  }
}
