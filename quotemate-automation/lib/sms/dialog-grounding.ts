// Phase 1b — the electrical/generic dialog turn may not ship a figure,
// product name or link that no tool produced.
//
// Roofing has had this guard since llm-receptionist.ts shipped: any model
// turn stating an ungrounded number is discarded and the pure state machine
// answers instead. The electrical branch never wired it up, and its prompt
// actively taught the model to write dollar amounts. Electrical has no state
// machine to fall back to, only a holding line, so we swap the reply TEXT and
// leave every routing field exactly as the model returned it.
//
// Not in inbound-helpers.ts on purpose: that module documents itself as
// import-free, and assertGroundedReply lives in llm-receptionist.ts, which
// pulls in @ai-sdk/anthropic. Keeping this seam separate keeps the pure
// helpers pure.

import { assertGroundedReply } from './llm-receptionist'
import { deriveTradeFromJobType } from '@/lib/intake/schema'
import { INSPECTION_FEE_AUD } from '@/lib/quote/money'

/** The subset of TurnDecision this guard reads. Structural so the route can
 *  pass its decision straight in without a cast. */
export type DialogDecisionLike = {
  action: string
  reply_to_send: string
  ready_for_intake: boolean
  job_type_guess?: string | null
}

/**
 * Guard a dialog turn's reply text.
 *
 * `modelAuthored` is load-bearing. A route-composed reply (the inspection
 * offer, the Rule 5/6 name/suburb questions, the readiness-gate question) is
 * deterministic and therefore trusted — and the inspection offer could never
 * satisfy the guard anyway, because money is refused before any grounding
 * lookup happens. Guarding it would bail every escalation.
 */
export function enforceDialogGrounding(args: {
  decision: DialogDecisionLike
  authoritative: string[]
  conversational: string[]
  fallbackReply: string
  modelAuthored: boolean
}): { decision: DialogDecisionLike; grounded: boolean; reason: string | null } {
  if (!args.modelAuthored) {
    return { decision: args.decision, grounded: true, reason: null }
  }
  const verdict = assertGroundedReply(
    args.decision.reply_to_send,
    args.authoritative,
    args.conversational,
  )
  if (verdict.ok) {
    return { decision: args.decision, grounded: true, reason: null }
  }
  // Swap the text only. action / ready_for_intake / job_type_guess carry the
  // turn's routing and are the model's job, not the guard's.
  return {
    decision: { ...args.decision, reply_to_send: args.fallbackReply },
    grounded: false,
    reason: verdict.reason,
  }
}

/**
 * The inspection offer, composed by the route so the fee comes from the one
 * shared constant instead of the eleven hardcoded prompt sites in dialog.ts.
 * Kept well inside TurnDecisionSchema's 320-character reply cap.
 */
export function composeInspectionOffer(
  jobType: string | null | undefined,
  firstName: string | null | undefined,
  tenantTrades?: readonly string[],
): string {
  const first = (firstName ?? '').split(' ')[0] || ''
  const namePart = first ? ` ${first}` : ''
  const unknownJob = !jobType || jobType === 'unknown' || jobType === 'other'
  // `switchboard` is a prompt trigger word but is NOT in the job_type_guess
  // enum, so its escalation always arrives as 'unknown'. When the tenant does
  // only one of the two trades we can still name the right tradie; when they
  // do both, staying generic is the honest answer.
  const soleTrade = (() => {
    const t = (tenantTrades ?? []).filter((x) => x === 'electrical' || x === 'plumbing')
    return t.length === 1 ? t[0] : null
  })()
  const trade = unknownJob ? soleTrade : deriveTradeFromJobType(jobType)
  const who = !trade ? 'someone out' : trade === 'plumbing' ? 'a plumber' : 'a sparky'
  return `Thanks${namePart} - for that we'll need to send ${who} for a quick look. Want me to text you a $${INSPECTION_FEE_AUD} inspection booking? It's credited toward the job if you go ahead.`
}

// ── Never claim to send a link that is not being sent ───────────────────
//
// The URL is never part of the model's reply: the photo link is a SEPARATE,
// deterministic SMS, and whether it goes out is decided by
// shouldSendPhotoRequest — which never sees the reply text. So the model can
// promise a link the sender has already been latched out of delivering, and
// nothing notices. In production, 204 of 245 outbound messages mentioning a
// "link" carried no URL, across 136 conversations and all five active tenants.
//
// assertGroundedReply cannot catch this: it validates only content the model
// EMITTED (money, counts, areas, links) — a MISSING link trips none of its
// branches. This is the complementary check, and it is deliberately a strip,
// not an append: appending the URL here would bypass every negative gate in
// photo-request-trigger.ts, each of which encodes real incident history.

/** A clause promising a link is on its way ("sending the link now",
 *  "I'll flick you a link", "resending now"). */
const PROMISE_CLAUSE_RE =
  /\b(send|sending|sent|resend|resending|re-send|flick|flicking|text|texting|share|sharing|shoot|shooting)\b/i

/** A clause that only makes sense once a link exists ("just tap it",
 *  "tap the link to upload a photo"). Dangling without a URL, so it goes too. */
const DANGLING_CLAUSE_RE = /\b(tap|click|follow|open|use)\b.*\b(it|link|below|through)\b/i

/** Said when the reply would otherwise be emptied. True, and promises nothing. */
export const NO_LINK_FALLBACK = "Thanks - I'll get your quote sorted and come back to you shortly."

/**
 * Remove any promise to send a link from a drafted reply.
 *
 * PURE. Apply it ONLY when no link is actually going out on this turn — it is
 * the complement to shouldSendPhotoRequest, not a replacement for it.
 *
 * Works clause by clause rather than sentence by sentence, because the real
 * failing messages put the whole promise in one clause of a single sentence
 * ("No worries Jeff - sending that link through again now, just tap it to…").
 * Sentence-level stripping would take the entire reply.
 *
 * Never appends the URL: doing so would bypass every negative gate in
 * photo-request-trigger.ts, each of which encodes real incident history.
 */
export function stripLinkPromise(reply: string): string {
  if (!reply) return reply
  // A reply carrying a real URL is telling the truth — leave it alone.
  if (/https?:\/\//i.test(reply)) return reply
  if (!/\b(link|upload)\b/i.test(reply)) return reply

  // Split on clause boundaries, KEEPING the separators so the rejoin reads
  // naturally. Sentence enders are boundaries too.
  const parts = reply.split(/([,;]|\s+[—–-]\s+|(?<=[.!?])\s+)/)
  const kept: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i] ?? ''
    const sep = parts[i + 1] ?? ''
    const mentionsLink = /\b(link|upload)\b/i.test(clause)
    // The whole reply is already known to be about a link, so a bare promise
    // clause with no object ("resending now", "sending that through again")
    // is promising the link even without naming it. Dispatching a PERSON is a
    // different promise and must survive.
    const promisesSomeone = /\b(someone|sparky|plumber|electrician|tech|team|crew)\b/i.test(clause)
    const drop =
      (PROMISE_CLAUSE_RE.test(clause) && !promisesSomeone) ||
      (mentionsLink && DANGLING_CLAUSE_RE.test(clause)) ||
      // "just tap it" — refers to a link named in a clause we just dropped.
      (kept.length > 0 && DANGLING_CLAUSE_RE.test(clause) && /\bit\b/i.test(clause))
    if (!drop) kept.push(clause.trim() ? clause.trim() + (sep.trim() === ',' ? ',' : '') : '')
  }

  let out = kept.filter(Boolean).join(' ')
  out = out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.!?,])/g, '$1')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/^[\s,;:—–-]+/, '')
    .replace(/[\s,;:—–-]+$/, '')
    .trim()

  // Nothing meaningful survived — say something true instead of shipping a
  // fragment or, worse, the original promise.
  if (out.replace(/[^a-z]/gi, '').length < 12) return NO_LINK_FALLBACK
  if (!/[.!?]$/.test(out)) out += '.'
  return out
}
