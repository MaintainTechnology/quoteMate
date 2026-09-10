'use client'

// SendQuotePanel — the "Send to Customer" toolbar action on the dashboard
// quote viewer. Toggles a dropdown with an SMS row (number on file, or a
// manual input when none) and an email row (prefilled, editable, PDF
// attached). Both rows POST to /api/quote/[id]/send with the tradie's bearer
// token; the server owns auth, recipient fallback, dispatch and lifecycle.

import { useRef, useState } from 'react'
import { getAuthToken } from '@/lib/auth/client-token'

type RowState = { pending: boolean; ok: string | null; err: string | null }
type DeliveryIntent = { requestId?: string; expected_recipient: string; expected_revision?: string; to?: string }
const idle: RowState = { pending: false, ok: null, err: null }

export default function SendQuotePanel(props: {
  quoteId: string
  reviewVersion?: string
  sentBefore?: boolean
  customerPhone: string | null
  customerEmail: string | null
  paid: boolean
  /** Button text — the Quotes-tab action bar labels it "Confirm & Send" for
   *  quotes still awaiting the tradie's review (lib/quote/send-customer
   *  confirmSendCta). Defaults to the viewer's "Send to Customer". */
  label?: string
  /** Open the dropdown above the button — needed inside the Quotes-tab
   *  sticky bottom action bar, where downward would clip off-viewport. */
  dropUp?: boolean
  /** Post-site-visit child rows are SMS-only (spec R9): buildQuoteEmail's copy
   *  is generic and carries no deposit link, no $99 credit and no fee line, so
   *  an emailed final quote tells the customer nothing about what they owe.
   *  The send route refuses the channel too — this just stops offering it. */
  smsOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [reviewUrl,setReviewUrl] = useState<string | null>(null)
  const [smsNeedsRecovery,setSmsNeedsRecovery] = useState(false)
  const [emailNeedsCheck,setEmailNeedsCheck] = useState(false)
  const [recipientNeedsReview, setRecipientNeedsReview] = useState<Record<string, boolean>>({})
  const [activeRecipients, setActiveRecipients] = useState<Record<string, string | undefined>>({})
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState(props.customerEmail ?? '')
  const [sms, setSms] = useState<RowState>(idle)
  const [mail, setMail] = useState<RowState>(idle)

  const deliveryIntent = useRef<Record<string, DeliveryIntent | undefined>>({})

  async function send(channel: 'sms' | 'email') {
    const setRow = channel === 'sms' ? setSms : setMail
    const previous = channel === 'sms' ? sms : mail
    if (previous.pending || recipientNeedsReview[channel] || (channel === 'sms' && smsNeedsRecovery) || (channel === 'email' && emailNeedsCheck)) return
    // Keep the reviewed recipient, override and revision with an uncertain
    // request. A retry must not reuse its UUID with newly displayed contact data.
    if (previous.ok || !deliveryIntent.current[channel]) {
      const recipient = channel === 'sms' ? (props.customerPhone?.trim() || phone.trim()) : email.trim()
      if (!recipient) {
        setRow({ pending: false, ok: null, err: 'Review a customer recipient before sending.' })
        return
      }
      const to = channel === 'sms' ? (props.customerPhone?.trim() ? undefined : recipient)
        : recipient !== (props.customerEmail ?? '').trim() ? recipient : undefined
      deliveryIntent.current[channel] = {
        expected_recipient: recipient,
        expected_revision: props.reviewVersion,
        ...(to ? { to } : {}),
        ...(previous.ok || (props.sentBefore ?? props.label === 'Send to Customer') ? { requestId: crypto.randomUUID() } : {}),
      }
    }
    const intent = deliveryIntent.current[channel]!
    setActiveRecipients(current => ({ ...current, [channel]: intent.expected_recipient }))
    setRow({ pending: true, ok: null, err: null })
    try {
      const token = await getAuthToken()
      if (!token) {
        setRow({ pending: false, ok: null, err: 'Sign in as the quote owner to send.' })
        return
      }
      const res = await fetch(`/api/quote/${props.quoteId}/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel, ...intent }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?:boolean
        message?: string
        error?: string
        accepted?: boolean
        review_url?:string
      }
      if (res.status === 401 || res.status === 403) {
        setRow({ pending: false, ok: null, err: 'Sign in as the quote owner to send.' })
        return
      }
      if (!res.ok || !body.ok) {
        if (body.error === 'quote_recipient_changed' || body.error === 'quote_contact_unavailable') {
          setRecipientNeedsReview(current => ({ ...current, [channel]: true }))
          setRow({ pending: false, ok: null, err: 'The reviewed recipient could not be confirmed. Refresh and review the contact before sending.' })
          return
        }
        // A rejected input has not committed a delivery intent; allow a manual
        // correction. Other failures keep the original request for safe retry.
        if (res.status === 400) {
          delete deliveryIntent.current[channel]
          setActiveRecipients(current => ({ ...current, [channel]: undefined }))
        }
        if (body.review_url?.startsWith('/dashboard/quote/')) setReviewUrl(body.review_url)
        setRow({
          pending: false,
          ok: null,
          err: body.message ?? body.error ?? 'Send failed — try again.',
        })
        return
      }
      if(channel === 'sms' && body.accepted === false)setSmsNeedsRecovery(true)
      setActiveRecipients(current => ({ ...current, [channel]: undefined }))
      setRow({
        pending: false,
        ok: channel === 'sms' ? body.accepted === false ? 'Approved; SMS delivery needs recovery. Check SMS delivery.' : 'SMS accepted by carrier.' : 'Email accepted by provider.',
        err: null,
      })
    } catch {
      if(channel === 'email')setEmailNeedsCheck(true)
      setRow({ pending: false, ok: null, err: channel === 'email' ? 'Email outcome is unknown. Check provider delivery before sending again.' : 'Send response was lost. Retry this same SMS request to check its saved result.' })
    }
  }

  const smsReady = !sms.pending && !smsNeedsRecovery && !recipientNeedsReview.sms && (!!activeRecipients.sms || !!props.customerPhone?.trim() || phone.trim().length > 0)
  const mailReady = !mail.pending && !emailNeedsCheck && !recipientNeedsReview.email && email.trim().length > 0
  const reviewedSmsPhone = activeRecipients.sms ?? props.customerPhone

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={props.paid}
        title={props.paid ? 'This quote is paid — nothing further to send.' : undefined}
        className="rounded-ctl inline-flex min-h-[40px] items-center gap-2 bg-accent px-4 py-2 text-xs font-bold uppercase tracking-wider text-accent-ink transition-colors hover:bg-accent-press disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent"
      >
        {props.label ?? 'Send to Customer'}
      </button>

      {open && !props.paid && (
        <div
          className={`absolute z-40 w-[22rem] max-w-[calc(100vw-2rem)] border border-ink-line bg-ink-deep p-4 shadow-lg ${
            // Quotes-tab mount sits leftmost in the pinned bottom bar, so the
            // panel opens up + left-aligned; the viewer button hugs the right
            // screen edge, so it keeps the original down + right-aligned drop.
            props.dropUp ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-2'
          }`}
        >
          {/* ─── SMS row ─── */}
          <div className="mb-4">
            <div className="mb-1 text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
              Text message
            </div>
            {reviewedSmsPhone ? (
              <div className="mb-2 text-sm text-text-sec">{reviewedSmsPhone}</div>
            ) : (
              <input
                type="tel"
                disabled={!!activeRecipients.sms || recipientNeedsReview.sms}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Customer mobile, e.g. +61 4xx xxx xxx"
                className="mb-2 w-full border border-ink-line bg-transparent px-3 py-2 text-sm text-text-pri placeholder:text-text-dim"
              />
            )}
            <button
              type="button"
              onClick={() => send('sms')}
              disabled={!smsReady}
              className="rounded-ctl inline-flex min-h-[36px] items-center border border-ink-line px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-text-pri transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {sms.pending ? 'Sending…' : sms.ok ? 'Send SMS again' : 'Send SMS'}
            </button>
            {sms.ok && <p className="mt-1 text-xs text-text-sec">{sms.ok}</p>}
            {sms.err && <p className="mt-1 text-xs text-accent">{sms.err}</p>}
            {recipientNeedsReview.sms && <button type="button" className="mt-2 block text-sm underline" onClick={() => window.location.reload()}>Refresh and review contact</button>}
            {reviewUrl && <a className="mt-2 block text-sm underline" href={reviewUrl}>Review the full quote</a>}
            {smsNeedsRecovery && <a className="mt-2 block text-sm underline" href="/dashboard/sms-delivery">Check SMS delivery</a>}
          </div>

          {/* ─── Email row — hidden on post-site-visit children (R9) ─── */}
          <div hidden={props.smsOnly}>
            <div className="mb-1 text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
              Email (PDF attached)
            </div>
            <input
              type="email"
              disabled={!!activeRecipients.email || emailNeedsCheck || recipientNeedsReview.email}
              value={activeRecipients.email ?? email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@example.com"
              className="mb-2 w-full border border-ink-line bg-transparent px-3 py-2 text-sm text-text-pri placeholder:text-text-dim"
            />
            <button
              type="button"
              onClick={() => send('email')}
              disabled={!mailReady}
              className="rounded-ctl inline-flex min-h-[36px] items-center border border-ink-line px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-text-pri transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {mail.pending ? 'Sending…' : 'Send Email'}
            </button>
            {mail.ok && <p className="mt-1 text-xs text-text-sec">{mail.ok}</p>}
            {mail.err && <p className="mt-1 text-xs text-accent">{mail.err}</p>}
            {recipientNeedsReview.email && <button type="button" className="mt-2 block text-sm underline" onClick={() => window.location.reload()}>Refresh and review contact</button>}
          </div>
        </div>
      )}
    </div>
  )
}
