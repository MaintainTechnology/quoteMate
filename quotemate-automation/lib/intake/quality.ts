// Single source of truth for "did the call capture enough to quote?"
//
// Used by /api/intake/structure to decide whether to dispatch the
// estimation engine + photo-request SMS, or to short-circuit and send
// a brief callback-request SMS instead.
//
// Rule: an intake is 'empty' when confidence is LOW AND we don't have a
// usable caller name OR a usable scope description. job_type='other' is
// NOT on its own a reason to fail — tenant-custom assemblies (insect
// zapper, EV charger, induction cooktop, etc.) legitimately fall outside
// the structured enum, but the dialog has already gathered enough info
// for the estimator to attempt a quote. If the estimator can't price the
// custom service, the grounding validator falls back to the $99
// inspection — far better than re-asking the customer "what kind of
// work?" when they just spent six turns describing it.
//
// MEDIUM and HIGH confidence intakes always proceed — Sonnet/Opus has
// already certified there's enough signal to draft against.

export type IntakeQuality = 'usable' | 'empty'

export type IntakeQualityInput = {
  confidence: 'LOW' | 'MEDIUM' | 'HIGH'
  caller?: { name?: string | null } | null
  scope?: { description?: string | null } | null
  job_type: string
}

const MIN_SCOPE_CHARS = 10
const MIN_NAME_CHARS = 2

export function evaluateIntakeQuality(intake: IntakeQualityInput): IntakeQuality {
  if (intake.confidence !== 'LOW') return 'usable'

  const name = (intake.caller?.name ?? '').trim()
  const scope = (intake.scope?.description ?? '').trim()

  const hasUsableName =
    name.length >= MIN_NAME_CHARS && name.toLowerCase() !== 'unknown'
  const hasUsableScope = scope.length >= MIN_SCOPE_CHARS

  // LOW confidence + missing name OR scope → empty (truly nothing to estimate
  // against). job_type='other' alone is no longer a fail — the downstream
  // estimator + grounding validator decide whether to quote or escalate to
  // inspection. See the 2026-05-19 "bug zapper" incident for why this
  // matters: a custom tenant assembly finished the dialog cleanly but the
  // old gate sent the customer a generic "what kind of work?" recovery SMS.
  if (!hasUsableName || !hasUsableScope) return 'empty'
  return 'usable'
}
