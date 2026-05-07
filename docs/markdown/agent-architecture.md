# agent-architecture

_Converted from `agent-architecture.html`._

---

  QuoteMate · Voice + SMS Agent Architecture

# QuoteMate · Voice + SMS Agent Architecture

Two input channels → one shared intake + estimate pipeline → one customer SMS reply

SHARED PIPELINE — channel-agnostic callId conversationId Customer AU mobile Vapi voice agent Twilio SMS / MMS /api/vapi/webhook end-of-call-report /api/sms/inbound Haiku Dialog Agent calls transcript · photos sms\_conversations sms\_messages · MMS /api/intake/structure channel-agnostic handler Opus 4.7 Vision Intake Agent intakes Postgres · pgvector Opus 4.7 + RAG Estimate Agent quotes 3 tiers · share token Stripe Connect Express 3 deposit links Quote SMS → Customer

### Voice path

-   • Customer rings AU long code
-   • Vapi runs the live conversation
-   • `end-of-call-report` webhook fires
-   • Transcript + photos persist in `calls`
-   • Hands off with `callId`

### SMS path

-   • Customer texts AU long code
-   • Twilio webhook → `/api/sms/inbound`
-   • Haiku decides `ask · finish · escalate`
-   • Turns persist in `sms_messages`
-   • On `finish`, hands off with `conversationId`

### Shared pipeline

-   • Opus 4.7 Vision structures the intake
-   • `pgvector` embedding for RAG anchor
-   • Estimate agent reads similar past quotes
-   • Drafts 3 tiers + Stripe sessions
-   • One Quote SMS back to the customer

QuoteMate · Voice + SMS Agent · channel-agnostic intake + estimate
