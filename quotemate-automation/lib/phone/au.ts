// AU mobile normaliser / validator — single source of truth for the
// Follow-ups call & text feature (and anywhere else that must prove a
// number is a real Australian mobile before spending money on it).
//
// We deliberately validate AU *mobiles* only (+61 4xx xxx xxx). The
// follow-up feature texts and rings customer mobiles; a landline or a
// foreign number should be rejected up-front with a clear reason rather
// than fail late inside Twilio. Twilio's own error codes remain the
// authoritative backstop (see lib/sms/twilio-error.ts) — this is the
// cheap pre-flight gate.

/** Normalise common AU mobile formats to E.164 (+614xxxxxxxx).
 *  Returns null when the input is not a valid AU mobile. Idempotent. */
export function normaliseAuMobile(input: string | null | undefined): string | null {
  if (!input) return null
  const s = String(input).replace(/[^\d+]/g, '')
  if (!s) return null

  let e164: string | null = null
  if (s.startsWith('+61')) e164 = s
  else if (s.startsWith('61') && s.length === 11) e164 = `+${s}`
  else if (s.startsWith('04') && s.length === 10) e164 = `+61${s.slice(1)}`
  else if (s.startsWith('4') && s.length === 9) e164 = `+61${s}`

  if (!e164) return null
  // AU mobile = +61 then 4 then 8 digits → exactly +614xxxxxxxx.
  if (!/^\+614\d{8}$/.test(e164)) return null
  return e164
}

export function isValidAuMobile(input: string | null | undefined): boolean {
  return normaliseAuMobile(input) !== null
}

/** Human-friendly AU local form for display, e.g. "0480 808 517". */
export function formatAuLocal(input: string | null | undefined): string | null {
  const e164 = normaliseAuMobile(input)
  if (!e164) return null
  const local = `0${e164.slice(3)}` // strip +61, restore leading 0
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`
}
