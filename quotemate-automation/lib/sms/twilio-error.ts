// Turn Twilio / dispatch error codes into one plain-English sentence the
// VA can act on. Shared by the follow-up text + call endpoints and shown
// verbatim in the dashboard modal/card. Keep messages blame-free and
// actionable — the VA is not technical.
//
// Codes seen from lib/sms/twilio.ts + lib/sms/dispatch.ts:
//   21610  recipient sent STOP (opted out)            — legal block
//   21211 / 21214 / 21614  invalid / not a mobile 'To'
//   21408  no permission to message that region
//   21612  message can't be routed to that carrier
//   30006  landline / unreachable carrier
//   NO_FROM / NO_CREDS  sender not configured
//   NETWORK  fetch failed before reaching Twilio
//   5xx      Twilio server error (transient)

export function friendlyTwilioError(
  code: string | null | undefined,
  fallbackReason?: string | null,
): string {
  switch (String(code)) {
    case '21610':
      return 'This customer replied STOP — they have opted out. You cannot text them from here (call them instead).'
    case '21211':
    case '21214':
    case '21614':
    case '21408':
      return "That isn't a reachable Australian mobile number."
    case '21612':
    case '30006':
      return "The carrier wouldn't accept this message. Try calling the customer instead."
    case 'NO_FROM':
    case 'NO_CREDS':
      return 'This account has no SMS number set up yet — it needs provisioning before texts can be sent.'
    case 'NETWORK':
      return 'Network problem reaching the SMS provider. Please try again.'
    default: {
      if (/^5\d\d$/.test(String(code))) {
        return 'The SMS provider had a temporary error. Please try again in a moment.'
      }
      const r = fallbackReason?.trim()
      return r
        ? `Couldn't send the message: ${r}`
        : "Couldn't send the message. Please try again."
    }
  }
}

/** Same idea for the click-to-call leg. */
export function friendlyCallError(
  code: string | null | undefined,
  fallbackReason?: string | null,
): string {
  switch (String(code)) {
    case 'NO_VOICE_NUMBER':
      return 'This account has no phone number set up for outbound calls yet.'
    case 'NO_TRADIE_NUMBER':
      return "No mobile on file for the tradie to ring first — add one in Account."
    case 'NO_CREDS':
      return 'The calling provider is not configured — contact support.'
    case 'NETWORK':
      return 'Network problem reaching the calling provider. Please try again.'
    default: {
      if (/^5\d\d$/.test(String(code))) {
        return 'The calling provider had a temporary error. Please try again.'
      }
      const r = fallbackReason?.trim()
      return r ? `Couldn't start the call: ${r}` : "Couldn't start the call. Please try again."
    }
  }
}
