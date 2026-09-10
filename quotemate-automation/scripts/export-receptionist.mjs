#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// export-receptionist.mjs — carve one self-contained NestJS receptionist
// service out of this monorepo, per trade.
//
//   node scripts/export-receptionist.mjs            # all five
//   node scripts/export-receptionist.mjs roofing    # just one
//   node scripts/export-receptionist.mjs --dry      # report, copy nothing
//
// What it does, per trade:
//   1. Copies app/api/sms/inbound/route.ts, app/api/intake/structure/route.ts
//      and app/api/estimate/draft/route.ts, deleting the OTHER trades'
//      handler functions + their call blocks, then stripping the imports
//      that go unused as a result.
//   2. Walks the import graph from those three files and copies the exact
//      closure of lib/ files each trade needs — nothing more.
//   3. Writes the NestJS shell: main.ts (Swagger), modules, controllers,
//      DTOs, tsconfig, package.json with only the deps the closure imports.
//
// Copied lib/ files are BYTE-IDENTICAL to source. The `@/*` path alias is
// preserved (tsconfig paths + tsc-alias at build), so re-running this after
// a monorepo change produces a clean diff instead of a merge conflict.
// Every candidate records its canonical source and website contract hashes.
// Rebuild and verify the candidate when either side of that contract changes.
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { collectPlatformContractFiles } from './receptionist-platform-contract.mjs'
import { receptionistSourceHash } from './receptionist-release-fingerprint.mjs'
import { REQUIRED_RECEPTIONIST_MIGRATIONS, RECEPTIONIST_SCHEMA_FILES } from './receptionist-schema-contract.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = resolve(HERE, '..')
const OUT_ROOT = resolve(process.argv.find((a) => a.startsWith('--out-root='))?.slice('--out-root='.length) ?? 'C:/Users/dalig/Desktop/MaintainTech/MaintainOrg/QuoteMax/Receptionists')

const SRC_PKG = JSON.parse(readFileSync(join(SRC_ROOT, 'package.json'), 'utf8'))

// ── trade config ─────────────────────────────────────────────────────────
// `handlers` = which of the two dedicated SMS receptionists this service
// keeps. Electrical/plumbing use the shared dialog; solar uses the dedicated
// solar hook in the shared route before the general dialog.
// `dialog` is the TRADE-ISOLATION control, added 2026-08-05 after the audit
// found every service running the shared electrical/plumbing dialog scoped by
// tenants.trades[] rather than by the service's own trade.
//
//   dialog: 'electrical'  the general dialog RUNS here, hard-scoped to that
//                         trade — tradeScopeDirective's existing
//                         "ELECTRICAL jobs ONLY. They do NOT do plumbing"
//                         branch fires instead of the permissive "BOTH" one.
//   dialog: null          the dedicated handler owns intake and pricing.
//                         Unclaimed questions use the scoped conversational
//                         fallback, which can answer and clarify but never price.
const TRADES = {
  electrical: {
    handlers: [],
    dialog: 'electrical',
    port: 3101,
    blurb: 'Electrical SMS AI receptionist — general dialog intake → Opus estimation → G/B/B quote.',
  },
  plumbing: {
    handlers: [],
    dialog: 'plumbing',
    port: 3102,
    blurb: 'Plumbing SMS AI receptionist — general dialog intake → Opus estimation → G/B/B quote.',
  },
  roofing: {
    handlers: ['roofing'],
    dialog: null,
    port: 3103,
    blurb: 'Roofing SMS AI receptionist — form or SMS details → measure → saved draft → tradie review and release.',
  },
  painting: {
    handlers: ['painting'],
    dialog: null,
    port: 3104,
    blurb: 'Painting SMS AI receptionist — gather → deterministic estimate → tradie-released quote.',
  },
  solar: {
    handlers: [],
    dialog: null,
    port: 3105,
    blurb: 'Solar SMS AI receptionist — address, phase and panel preferences → deterministic saved draft → installer review and release.',
  },
}

// Trades whose engine code must be force-included even when the trimmed
// route no longer references it. Keep the solar publication dependencies in
// the artefact alongside its dedicated SMS intake and deterministic engine.
const FORCE_INCLUDE = {
  solar: ['lib/solar/estimate.ts', 'lib/solar/publish.ts', 'lib/solar/release.ts', 'lib/solar/notify.ts'],
  electrical: ['lib/estimate/electrical-prompt.ts'],
  plumbing: ['lib/estimate/plumbing-prompt.ts'],
  roofing: [],
  painting: [],
}

// ── web surface ──────────────────────────────────────────────────────────
// Canonical page/auth/sandbox sources live in scripts/web-surface/ and are
// copied verbatim into every service; only content.ts is generated here, so
// all six sites stay byte-identical except for what they say.

const WEB_FILES = ['design.ts', 'session.ts', 'session.check.ts', 'sandbox.service.ts', 'web.controller.ts', 'web.module.ts']

const RECEPTIONIST_ENDPOINTS = [
  { method: 'POST', path: '/api/sms/inbound', auth: 'Twilio signature', desc: 'Production webhook — the tenant’s Twilio number points here. Form-encoded, signature-validated.' },
  { method: 'POST', path: '/api/receptionist/simulate', auth: 'x-sim-key', desc: 'Test harness: same pipeline from JSON. The sandbox drives this. Needs SMS_SIMULATE_ENABLED=1.' },
  { method: 'POST', path: '/api/intake/structure', auth: 'Bearer CRON_SECRET', desc: 'Intake engine — free text + photos into a structured, validated intake.' },
  { method: 'POST', path: '/api/estimate/draft', auth: 'Bearer CRON_SECRET', desc: 'Estimation engine — grounded G/B/B quote, validated line-by-line against the pricing book.' },
  { method: 'GET', path: '/api/health', auth: 'none', desc: 'Liveness. Railway’s healthcheck target.' },
  { method: 'GET', path: '/api/health/deep', auth: 'none', desc: 'Readiness — 503 plus missing variable names when configuration is incomplete.' },
]

const RECEPTIONIST_AUTH = [
  { name: 'Twilio signature', body: 'Inbound webhooks are validated against the Twilio auth token — a request that does not come from Twilio is rejected before any processing.' },
  { name: 'x-sim-key header', body: 'The simulate channel (and therefore the sandbox) requires SMS_SIMULATE_ENABLED=1 and a matching SIM_API_KEY. Closed by default.' },
  { name: 'Bearer CRON_SECRET', body: 'The internal intake and estimate engines only accept calls carrying the shared secret. Absent in production, the pipeline fails closed.' },
  { name: 'Operator session', body: 'The web sandbox and keys pages sit behind WEB_ADMIN_PASSWORD with an HMAC-signed 24-hour cookie.' },
]

const RECEPTIONIST_KEYS = [
  { env: 'SIM_API_KEY', label: 'Simulate key', desc: 'Opens POST /api/receptionist/simulate (the sandbox and the Front Desk both use it). Rotate by changing the Railway variable on this service AND the Front Desk’s RECEPTIONIST_SIM_KEY.' },
  { env: 'CRON_SECRET', label: 'Internal secret', desc: 'Guards the intake/estimate self-calls. Shown for completeness — external callers should never need it.' },
]

const moduleMermaid = (pipelineLabel) => `flowchart LR
  IN["POST /api/sms/inbound\\nTwilio webhook"] --> TURN{receptionist turn}
  TURN -->|default| LLM["Sonnet dialog\\npicks a tool"]
  TURN -->|"any failure"| SM["deterministic\\nstate machine"]
  LLM --> GUARD["grounding guard\\nno invented figures"]
  SM --> GUARD
  GUARD --> PIPE[["${pipelineLabel}"]]
  PIPE --> DB[("Supabase\\nconversations - quotes")]
  PIPE --> SMS["reply SMS\\nvia Twilio"]
  SIM["POST /api/receptionist/simulate\\nsandbox - Front Desk"] --> TURN
  subgraph Engines["internal engines (Bearer CRON_SECRET)"]
    I2["/api/intake/structure"] --> E2["/api/estimate/draft"]
    E2 --> VAL["grounding validator\\nline items vs pricing book"]
    VAL --> Q["quote + Stripe deposit links"]
  end
  PIPE -.handoff.-> I2`

const WEB_CONTENT = {
  electrical: {
    name: 'Electrical Receptionist', tint: '#FFD34D',
    tagline: 'Texts in, a grounded electrical quote out — priced from the tradie’s own book, never guessed.',
    intro: [
      'This service answers a tradie’s SMS number like front-desk staff. A Claude-driven dialog gathers the job in plain language — what needs doing, where, access, photos — then hands a structured intake to the estimation engine.',
      'The estimator drafts a Good/Better/Best quote using tool calls only: every line item price is looked up in the tenant’s pricing book and shared assembly library, then checked by a grounding validator. Anything the database cannot substantiate downgrades the quote to a paid site inspection instead of guessing.',
      'The customer gets a quote link and Stripe deposit options by SMS, and the tradie is notified — usually inside a minute of the last question being answered.',
    ],
    capabilities: [
      { title: 'Natural SMS dialog', body: 'Greets, asks only what is missing, handles refusals and topic changes — Sonnet-driven with a deterministic fallback every turn.' },
      { title: 'Structured intake', body: 'Free text and photos become a validated intake: job type, scope, address, access, risks.' },
      { title: 'Grounded pricing', body: 'The model can only select priced rows via tools. A validator re-derives every line; failures route to inspection.' },
      { title: 'Good/Better/Best quotes', body: 'Three tiers with scope, assumptions and GST handling, delivered as a live link and PDF.' },
      { title: 'Stripe deposits', body: 'Deposit links minted per tier — pay-first booking straight from the quote page.' },
      { title: 'Photo requests', body: 'Asks for photos when the job needs eyes on it, with a tokenised upload link.' },
    ],
    flowTitle: 'From first text to priced quote',
    flow: `sequenceDiagram
  participant C as Customer
  participant T as Twilio
  participant R as Receptionist dialog
  participant I as Intake engine
  participant E as Estimator
  participant DB as Pricing book
  C->>T: "Need 4 downlights put in the kitchen"
  T->>R: POST /api/sms/inbound
  R->>C: asks address, access, timing
  C->>R: answers over a few texts
  R->>I: structured handoff
  I->>E: validated intake + photos
  E->>DB: price lookups (tool calls only)
  DB-->>E: grounded line items
  E->>E: grounding validator
  E-->>C: G/B/B quote link + deposit options
  E-->>R: tradie notified`,
    pipelineLabel: 'estimation engine\\nRAG + tool-calling',
    sandboxNote: 'A normal electrical turn answers in seconds; the final quote turn runs the full estimation engine and can take about a minute.',
  },
  plumbing: {
    name: 'Plumbing Receptionist', tint: '#6EC1FF',
    tagline: 'A leaking hot water system at 7am becomes a priced, bookable quote before the van leaves the driveway.',
    intro: [
      'This service answers a plumber’s SMS number like front-desk staff. A Claude-driven dialog gathers the job — fixture, fault, urgency, address, photos — then hands a structured intake to the estimation engine.',
      'Quotes are drafted with tool calls only: every price is looked up in the tenant’s pricing book and assembly library, then re-checked by a grounding validator. Unquotable jobs route to a paid site inspection rather than a guess.',
      'The customer gets a Good/Better/Best quote link with Stripe deposit options by SMS; the plumber gets notified with the full scope.',
    ],
    capabilities: [
      { title: 'Natural SMS dialog', body: 'Understands "no hot water since last night" and asks the two questions that matter — system type and access.' },
      { title: 'Structured intake', body: 'Free text and photos become a validated intake with job type, urgency and property detail.' },
      { title: 'Grounded pricing', body: 'Tool-calling only; a validator re-derives every line item against the pricing book.' },
      { title: 'Good/Better/Best quotes', body: 'Repair vs replace vs upgrade tiers, scoped and GST-correct.' },
      { title: 'Stripe deposits', body: 'Deposit links per tier, pay-first booking from the quote page.' },
      { title: 'Inspection fallback', body: 'Gas, capacity and compliance edge cases route to a $99 site visit instead of a wrong number.' },
    ],
    flowTitle: 'From first text to priced quote',
    flow: `sequenceDiagram
  participant C as Customer
  participant T as Twilio
  participant R as Receptionist dialog
  participant I as Intake engine
  participant E as Estimator
  participant DB as Pricing book
  C->>T: "Hot water system is leaking"
  T->>R: POST /api/sms/inbound
  R->>C: asks system type, address, access
  C->>R: answers + photo of the unit
  R->>I: structured handoff
  I->>E: validated intake
  E->>DB: price lookups (tool calls only)
  DB-->>E: grounded line items
  E->>E: grounding validator
  E-->>C: G/B/B quote link + deposit options
  E-->>R: plumber notified`,
    pipelineLabel: 'estimation engine\\nRAG + tool-calling',
    sandboxNote: 'A normal plumbing turn answers in seconds; the final quote turn runs the full estimation engine and can take about a minute.',
  },
  roofing: {
    name: 'Roofing Receptionist', tint: '#FF7A59',
    tagline: 'Address in, measured roof out — satellite measurement, deterministic pricing, a quote link by SMS.',
    intro: [
      'This service quotes roofs without a site visit. The dialog collects the address, verifies it on the map, then gathers intent (re-roof, repair, gutters), material and pitch.',
      'The measurement engine (Geoscape primary, with satellite fallbacks) measures every structure on the parcel. Pricing is fully deterministic — the language model never emits a price, an area or a structure count; a grounding guard discards any turn that states a figure no tool produced.',
      'The customer receives their roof photo, picks which building to quote, and gets a priced SMS with a live quote page and PDF. The tradie has a parallel dashboard surface with the same measurement.',
    ],
    capabilities: [
      { title: 'Address verification', body: 'Geocodes and confirms the exact parcel with the customer before anything is measured.' },
      { title: 'Satellite measurement', body: 'Geoscape-first roof measurement of every structure — areas, facets, edges — no ladder.' },
      { title: 'Deterministic pricing', body: 'Rate-card maths from measured area, material and pitch. The model never invents a number.' },
      { title: 'Structure selection', body: 'Sends the roof photo and asks which building(s) to quote — house, shed, garage.' },
      { title: 'Quote + PDF by SMS', body: 'Priced tiers on a live /q/roof page with a PDF, deposit links included.' },
      { title: 'LLM front, machine back', body: 'Sonnet handles the conversation; any failure falls back to a pure state machine for that turn.' },
    ],
    flowTitle: 'From address to measured, priced roof',
    flow: `sequenceDiagram
  participant C as Customer
  participant T as Twilio
  participant R as Receptionist dialog
  participant M as Measurement engine
  participant P as Deterministic pricer
  C->>T: "Quote to re-roof 12 Example St Brisbane"
  T->>R: POST /api/sms/inbound
  R->>C: confirms the address on the map
  R->>C: intent, material, pitch
  R->>M: measureAndPriceRoofs
  M-->>R: structures + measured areas
  R->>C: roof photo — "which building?"
  C->>R: "the house"
  R->>P: area x material x pitch
  P-->>C: priced SMS + /q/roof link + PDF
  Note over R,P: the model never emits a price or an area`,
    pipelineLabel: 'measure + price\\nGeoscape - rate card',
    sandboxNote: 'The measure step is real satellite measurement — that turn takes minutes, not seconds. Earlier turns answer quickly.',
  },
  painting: {
    name: 'Painting Receptionist', tint: '#C9A7FF',
    tagline: 'Gathers the repaint by SMS, prices it deterministically, and holds every quote for the painter’s release.',
    intro: [
      'This service gathers a residential painting job over SMS — interior or exterior, rooms or full house, condition — or hands the customer a self-serve form link.',
      'Wall area comes from a building lookup plus street imagery; pricing is deterministic from the painter’s rates. The customer sees a holding message, never a raw price.',
      'Every quote is review-required: prices and deposit links only unlock after the painter presses Send. The same LLM-with-deterministic-fallback conversation layer as the other trades drives the dialog.',
    ],
    capabilities: [
      { title: 'SMS or self-serve form', body: 'Gathers question-by-question over SMS, or sends a tokenised form link when that is faster.' },
      { title: 'Remote wall area', body: 'Building footprint + street imagery estimate wall area without a visit.' },
      { title: 'Deterministic pricing', body: 'Painter’s own rates drive the estimate. No model-invented figures anywhere.' },
      { title: 'Review-required release', body: 'The customer sees no price until the painter releases the quote — a hard gate, not a setting.' },
      { title: 'G/B/B on release', body: 'Released quotes present tiers with scope and deposit links on the live quote page.' },
      { title: 'LLM front, machine back', body: 'Sonnet conversation with a per-turn deterministic fallback, same as roofing.' },
    ],
    flowTitle: 'From enquiry to released quote',
    flow: `sequenceDiagram
  participant C as Customer
  participant T as Twilio
  participant R as Receptionist dialog
  participant E as Painting estimator
  participant P as Painter
  C->>T: "Quote to repaint the outside of my house"
  T->>R: POST /api/sms/inbound
  R->>C: gathers scope, surfaces, condition
  R->>E: wall area lookup + rate card
  E-->>R: deterministic estimate (held)
  R->>C: holding message — no price shown
  E->>P: quote ready for review
  P->>E: presses Send
  E-->>C: released quote link + deposit options`,
    pipelineLabel: 'painting estimator\\narea x rates, held for release',
    sandboxNote: 'Painting is review-required: the sandbox reply is a holding message — the priced quote only exists after the painter releases it.',
  },
  solar: {
    name: 'Solar Receptionist', tint: '#7BE495',
    tagline: 'A receptionist in front of a deterministic solar engine — sizing, rebate and payback with no guesswork.',
    intro: [
      'This service pairs the SMS dialog with QuoteMax’s deterministic solar engine. The conversation collects the address and energy goals; the engine does everything numeric.',
      'Roof facts feed system sizing capped by roof and export limits, annual production is cross-checked against CEC references, and pricing applies the STC rebate by postcode zone. Savings and payback come out as Good/Better/Best systems.',
      'No language model writes a price anywhere in the chain — the one AI touch, the roof brief, is prompted with zero dollar figures and validated.',
    ],
    capabilities: [
      { title: 'SMS-first solar intake', body: 'Collects address and goals conversationally — the gap that used to make "solar quote please" a dead lead.' },
      { title: 'Roof-aware sizing', body: 'Panel capacity fitted to the actual roof, capped by the network’s export limit.' },
      { title: 'Production modelling', body: 'Annual AC output cross-checked against CEC reference data.' },
      { title: 'STC rebate maths', body: 'Gross price minus the certificate rebate by postcode zone — shown, not hidden.' },
      { title: 'Payback economics', body: 'Bill offset, savings and payback period per tier.' },
      { title: 'Installer review', body: 'The SMS draft stays saved for installer review. A customer quote link is available after approval.' },
    ],
    flowTitle: 'From enquiry to sized, priced system',
    flow: `sequenceDiagram
  participant C as Customer
  participant T as Twilio
  participant R as Receptionist dialog
  participant S as Solar engine
  C->>T: "Keen for a solar quote"
  T->>R: POST /api/sms/inbound
  R->>C: address + energy goals
  R->>S: geocode, roof facts
  S->>S: sizing - production - STC rebate - payback
  S-->>R: saved draft awaiting installer review
  R-->>C: saved status; quote link after approval
  Note over S: fully deterministic — no LLM in the numbers`,
    pipelineLabel: 'solar engine\\nsizing - rebate - payback',
    sandboxNote: 'Solar gathers details through SMS and saves a deterministic draft for installer review. A customer quote requires approval.',
  },
}

function webContentTs(trade) {
  const w = WEB_CONTENT[trade]
  const obj = {
    service: `qm-${trade}-receptionist`,
    name: w.name,
    trade,
    tint: w.tint,
    tagline: w.tagline,
    intro: w.intro,
    capabilities: w.capabilities,
    flowTitle: w.flowTitle,
    flowMermaid: w.flow,
    moduleMermaid: moduleMermaid(w.pipelineLabel),
    endpoints: RECEPTIONIST_ENDPOINTS,
    sandbox: {
      mode: 'simulate-poll',
      path: '/api/receptionist/simulate',
      keyEnv: 'SIM_API_KEY',
      keyHeader: 'x-sim-key',
      enableFlag: 'SMS_SIMULATE_ENABLED',
      defaultFrom: '+61400000001',
      note: w.sandboxNote,
    },
    keys: RECEPTIONIST_KEYS,
    authModel: RECEPTIONIST_AUTH,
  }
  return `// GENERATED per-trade content — regenerated by scripts/export-receptionist.mjs.\n// Page/auth/sandbox code is shared; this file is the only thing that differs\n// between the six services.\nimport type { WebContent } from './design'\n\nexport const CONTENT: WebContent = ${JSON.stringify(obj, null, 2)}\n`
}

const ROUTES = [
  { from: 'app/api/sms/inbound/route.ts', to: 'src/receptionist/inbound.route.ts', trim: true },
  { from: 'app/api/intake/structure/route.ts', to: 'src/intake/structure.route.ts', trim: false },
  { from: 'app/api/estimate/draft/route.ts', to: 'src/estimate/draft.route.ts', trim: false },
]

// ── engine self-call redirection ─────────────────────────────────────────
// In the monolith, APP_URL serves BOTH the customer pages and the engine
// routes, so the route files self-call `${process.env.APP_URL}/api/...`. In a
// carved service those are different places: APP_URL must stay the public
// website (it builds every /q/* link a customer receives), while the intake/
// estimate engines run HERE. Rewrite the two self-call sites to prefer
// ENGINE_BASE_URL — defaulted to loopback in main.ts — which keeps the
// CRON_SECRET handshake inside one process and immune to redirects (found
// live 2026-08-04: www.quotemax.com.au 307-redirects to the apex, and fetch
// STRIPS the Authorization header on a cross-host redirect, so an engine
// call via APP_URL=www.… arrives secretless and 401s; the secret itself
// matches production). Copy-time transform, same policy as denextify: the
// monorepo file stays untouched upstream.
function redirectEngineCalls(src) {
  return src
    .replaceAll(
      '${process.env.APP_URL}/api/intake/structure',
      '${process.env.ENGINE_BASE_URL ?? process.env.APP_URL}/api/intake/structure',
    )
    .replaceAll(
      '${process.env.APP_URL}/api/estimate/draft',
      '${process.env.ENGINE_BASE_URL ?? process.env.APP_URL}/api/estimate/draft',
    )
}

// ── trade isolation ──────────────────────────────────────────────────────
// THE PROBLEM (audit, 2026-08-05). Deleting the other trades' HANDLERS was
// never enough. Underneath them sits the shared electrical/plumbing Sonnet
// dialog, which is the spine of the route and so is never carved out. It is
// scoped by `tenantTrades: tenant?.trades` — the TENANT's trade list from the
// database, not the service's own trade. Consequences measured in the audit:
//
//   · the painting service answers "6 downlights please" with the electrical
//     dialog and mints a priced ELECTRICAL quote with a Stripe link;
//   · the solar service has no solar SMS flow at all, so 100% of its traffic
//     is served by that same electrical/plumbing dialog;
//   · with tenant null (unmapped number) the scope defaults to BOTH trades.
//
// THE FIX. Route the single `decideNextTurn` import through a generated,
// per-service wrapper. One import specifier changes; the 3,900-line route is
// untouched. The wrapper either hard-scopes the dialog to this service's trade
// (electrical/plumbing) or uses a scoped conversational fallback that cannot
// mint an intake or price (roofing/painting/solar).
//
// Why a wrapper and not surgery on the call site: the call passes 14 args
// across 40 lines, and a text transform inside that block is exactly the kind
// of brittle edit that breaks silently on the next monorepo change. Swapping a
// module specifier is verifiable by grep.
function scopeDialogToService(src) {
  return src.replace(
    "import { decideNextTurn, type ConversationTurn } from '@/lib/sms/dialog'",
    "import { decideNextTurn, scopeTenantTrades, type ConversationTurn } from '@/lib/sms/service-dialog'",
  )
}

// The slot extractor is a SECOND Sonnet call given the same tenant trade list.
// Its trade-scope hint has NO else-branch (extract-slots.ts): a tenant holding
// neither 'electrical' nor 'plumbing' falls through to "this tradie covers
// PLUMBING jobs ONLY", so on a roofing-only tenant the extractor runs as a
// plumbing receptionist and writes plumbing job_types into conversation_state
// — which the intake handoff then reads.
//
// Both `tenantTrades:` sites are routed through scopeTenantTrades() rather
// than a literal list, and that indirection is deliberate:
//
//   · electrical/plumbing → returns the service's one trade, so the extractor
//     and the dialog both get the correct "<TRADE> jobs ONLY" branch;
//   · roofing/painting/solar → DIALOG_TRADES is null, so it PASSES THE TENANT
//     LIST THROUGH unchanged. Substituting ['roofing'] here would swap one
//     wrong hint for another (straight into that missing else-branch), and
//     fixing it properly means adding an else to shared monorepo code the
//     monolith also runs. The dialog itself is already neutralised by the
//     wrapper, so nothing is lost by leaving the extractor as it was.
function scopeSlotExtractor(src) {
  return src.replaceAll(
    'tenantTrades: tenant?.trades,',
    'tenantTrades: scopeTenantTrades(tenant?.trades),',
  )
}

// The plan-estimation short-circuit is an ELECTRICAL plan take-off feature —
// buildPlanUploadSms texts "Upload your electrical plan PDF … every light,
// power point and data point counted off the drawing". It runs BEFORE the
// conversation is even loaded, and its only gate is the tenant's
// `sms_estimator_enabled` column: no trade check anywhere. So on a tenant with
// that toggle on, "do you do take-offs?" is answered with an electrical
// upload link by the roofing, painting and solar services alike, and the
// service's own handler never sees the message.
//
// Gate it on the service trade for every non-electrical carve. Left fully
// intact in the electrical service, where it belongs.
// The monolith's retirement kill switch must NEVER be carved.
//
// app/api/sms/inbound/route.ts is BOTH the monolith's route and this script's
// source file. When the in-app receptionist was retired (2026-08-05) that guard
// went in at the top of POST — and the very next export carried it straight
// into the carved service, which then answered every turn with
// "RETIRED — in-app receptionist is disabled" and processed nothing.
//
// Found in production: the painting service accepted turns (201), wrote no
// conversation row and sent no reply, because the guard returns before any of
// the pipeline runs. The guard is correct FOR THE MONOLITH and wrong for a
// carve — these services ARE the receptionist it points at.
//
// Strip it here rather than flag-flipping it, for the same reason the plan
// estimation block is removed rather than disabled: what we mean is that the
// concept does not exist in a carved service.
function stripRetirementGuard(src) {
  const lines = src.split(/\r?\n/)
  const banner = lines.findIndex((l) => l.includes('RETIRED 2026-08-05'))
  if (banner === -1) return src // not present (pre-retirement source) — fine
  const start = banner - 1 // the ─── rule above the banner
  const postIdx = lines.findIndex((l, i) => i > banner && l.startsWith('export async function POST(req: Request) {'))
  if (postIdx === -1) throw new Error('stripRetirementGuard: POST not found after the banner')
  const guardIdx = lines.findIndex((l, i) => i > postIdx &&
    (l.trim() === 'if (!RECEPTIONIST_ENABLED) {' || l.trim() === 'if (!RECEPTIONIST_ENABLED) return flagRetiredSmsWebhook(req)'))
  if (guardIdx === -1) throw new Error('stripRetirementGuard: guard opener not found')
  // Walk to the guard's matching close by brace depth.
  let depth = 0
  let closeIdx = -1
  for (let i = guardIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    if (depth === 0) { closeIdx = i; break }
  }
  if (closeIdx === -1) throw new Error('stripRetirementGuard: guard close not found')
  return [
    ...lines.slice(0, start),
    ...lines.slice(start, postIdx).filter((line) => line.startsWith('const RETIRED_ACK =')),
    'export async function POST(req: Request) {',
    ...lines.slice(closeIdx + 1),
  ].join('\n')
}

// REMOVED, not disabled. A `false &&` guard was the first attempt and it broke
// the build in four services: TypeScript narrows `tenant` to non-null from
// `tenant?.sms_estimator_enabled`, and short-circuiting ahead of that narrowing
// left `TenantRow | null` flowing into a `TenantRow` parameter. Deleting the
// block is both what we mean and what compiles.
function gatePlanEstimation(src, trade) {
  if (trade === 'electrical') return src
  const anchor = 'if (tenant?.sms_estimator_enabled) {'
  const at = src.indexOf(anchor)
  if (at === -1) {
    throw new Error(`gatePlanEstimation: anchor not found — the plan-estimation guard moved (${trade})`)
  }
  const open = src.indexOf('{', at)
  const close = matchBrace(src, open)
  return (
    src.slice(0, at) +
    `// TRADE ISOLATION: the plan-estimation short-circuit is an ELECTRICAL\n` +
    `  // plan take-off (it texts "upload your electrical plan PDF"). It ran\n` +
    `  // before this service's own handler and was gated only on the tenant's\n` +
    `  // sms_estimator_enabled column, with no trade check — so it is removed\n` +
    `  // from the ${trade} carve entirely.\n` +
    src.slice(close + 1)
  )
}

/** The generated per-service dialog wrapper. */
function serviceDialogModule(trade) {
  const fallback = ['roofing','painting','solar'].includes(trade)
  return `// GENERATED: trade-scoped fallback never claims a nonexistent quote.
import { decideNextTurn as generalDialog, type ConversationTurn } from './dialog'
${fallback ? "import { decideScopedFallback } from './scoped-fallback'" : ''}
export type { ConversationTurn }
export const SERVICE_TRADE = ${JSON.stringify(trade)} as const
export function scopeTenantTrades<T extends string>(tenantTrades: readonly T[] | undefined): readonly T[] | undefined {
  return ${fallback ? 'tenantTrades' : `[SERVICE_TRADE] as unknown as readonly T[]`}
}
export async function decideNextTurn(args: Parameters<typeof generalDialog>[0]): Promise<Awaited<ReturnType<typeof generalDialog>>> {
  ${fallback ? 'return decideScopedFallback(args, SERVICE_TRADE)' : 'return generalDialog({ ...args, tenantTrades: [SERVICE_TRADE] })'}
}
`
}

// ── source trimming ──────────────────────────────────────────────────────

/** Index of the `}` matching the `{` at `open`. Skips strings, template
 *  literals, regex-ish slashes and both comment forms. */
function matchBrace(src, open) {
  if (src[open] !== '{') throw new Error(`matchBrace: no '{' at ${open}`)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue }
    if (c === '/' && next === '*') { i = src.indexOf('*/', i + 2) + 1; continue }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i++
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === quote) break
        // `${ ... }` inside a template can hold braces — step over it.
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          const inner = matchBrace(src, i + 1)
          i = inner + 1
          continue
        }
        i++
      }
      continue
    }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i }
  }
  throw new Error(`matchBrace: unbalanced from ${open}`)
}

/** Walk back from `idx` over the contiguous `//` comment block above it. */
function commentBlockStart(src, idx) {
  let lineStart = src.lastIndexOf('\n', idx - 1) + 1
  while (lineStart > 0) {
    const prevStart = src.lastIndexOf('\n', lineStart - 2) + 1
    const line = src.slice(prevStart, lineStart).trim()
    if (!line.startsWith('//')) break
    lineStart = prevStart
  }
  return lineStart
}

/** Remove `async function <name>(args: { ... }): Promise<boolean> { ... }`
 *  plus the comment block documenting it. */
function removeHandler(src, name) {
  const sig = `async function ${name}(args: {`
  const at = src.indexOf(sig)
  if (at < 0) return src
  const anchor = '): Promise<boolean> {'
  const anchorAt = src.indexOf(anchor, at)
  if (anchorAt < 0) throw new Error(`removeHandler: no body anchor for ${name}`)
  const bodyOpen = anchorAt + anchor.length - 1
  const end = matchBrace(src, bodyOpen)
  const start = commentBlockStart(src, at)
  let after = end + 1
  while (src[after] === '\n') after++
  return src.slice(0, start) + src.slice(after)
}

/** Remove `const <flag> = tenant … if (<flag> && …) { … } [else if … { … }]`. */
function removeCallBlock(src, flag) {
  const declSig = `const ${flag} = tenant`
  const declAt = src.indexOf(declSig)
  if (declAt < 0) return src
  const ifSig = `if (${flag} && !inflightContinuation) {`
  const ifAt = src.indexOf(ifSig, declAt)
  if (ifAt < 0) throw new Error(`removeCallBlock: no if-block for ${flag}`)
  let end = matchBrace(src, ifAt + ifSig.length - 1)
  // Consume any `} else if (...) { ... }` / `} else { ... }` tail.
  for (;;) {
    const tail = src.slice(end + 1, end + 40)
    const m = tail.match(/^\s*else\s*(if\s*\()?/)
    if (!m) break
    const braceAt = src.indexOf('{', end + 1 + m[0].length - (m[1] ? 1 : 0))
    if (braceAt < 0) break
    end = matchBrace(src, braceAt)
  }
  const start = commentBlockStart(src, declAt)
  let after = end + 1
  while (src[after] === '\n') after++
  return src.slice(0, start) + src.slice(after)
}

/** Drop import statements (and named specifiers) no longer referenced. */
function stripUnusedImports(src) {
  const importRe = /^import\s+(?:type\s+)?(?:([\w$]+)\s*,\s*)?(?:\{([\s\S]*?)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*from\s*'([^']+)'\s*$/gm
  const statements = []
  for (const m of src.matchAll(importRe)) {
    statements.push({ text: m[0], index: m.index, defaultName: m[1] || m[4] || null, named: m[2] || null, star: m[3] || null })
  }
  if (!statements.length) return src

  const importsEnd = statements[statements.length - 1].index + statements[statements.length - 1].text.length
  const body = src.slice(importsEnd)
  const used = (name) => new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(body)

  let out = src
  // Rewrite back-to-front so earlier indices stay valid.
  for (const st of [...statements].reverse()) {
    if (!st.defaultName && !st.named && !st.star) continue // side-effect import — keep
    let replacement = null
    if (st.named) {
      const specs = st.named.split(',').map((s) => s.trim()).filter(Boolean)
      const kept = specs.filter((s) => {
        // `type Foo`, `Foo as Bar`, `type Foo as Bar` → the local binding is
        // the last word, after dropping any inline `type` modifier. Missing
        // this deletes every type-only import in the file.
        const local = s.replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim()
        return used(local)
      })
      const defaultUsed = st.defaultName ? used(st.defaultName) : false
      if (!kept.length && !defaultUsed) replacement = ''
      else if (kept.length !== specs.length || (st.defaultName && !defaultUsed)) {
        const typeOnly = /^import\s+type\s/.test(st.text)
        const from = st.text.match(/from\s*'([^']+)'/)[1]
        const head = defaultUsed ? `${st.defaultName}, ` : ''
        const braces = kept.length ? `{ ${kept.join(', ')} }` : ''
        replacement = `import ${typeOnly ? 'type ' : ''}${head}${braces} from '${from}'`
      }
    } else {
      const local = st.star || st.defaultName
      if (!used(local)) replacement = ''
    }
    if (replacement === null) continue
    const before = out.slice(0, st.index)
    let afterIdx = st.index + st.text.length
    if (replacement === '') while (out[afterIdx] === '\n') afterIdx++
    out = before + replacement + (replacement === '' ? '' : '') + out.slice(afterIdx)
  }
  return out
}

/** Next-runtime shims + the `export const maxDuration` Next-only knob.
 *  Every `after()` import in this codebase is the identical one-liner, in
 *  the routes and in four lib/ modules — all of them get the shim. */
function denextify(src, toPath) {
  const depth = toPath.split('/').length - 2 // src/<dir>/file.ts -> 1
  const up = '../'.repeat(depth)
  return src
    .replace(/^import\s*\{\s*after\s*\}\s*from\s*'next\/server'\s*$/m, `import { after } from '${up}runtime/after'`)
    .replace(/^export const maxDuration = \d+\s*$/m, (m) => `// ${m.trim()} — Next-only; NestJS timeout lives in main.ts`)
}

// ── import-graph closure ─────────────────────────────────────────────────

const EXTS = ['.ts', '.tsx', '.mts', '.json']

function resolveSpec(spec, fromFile) {
  let base
  if (spec.startsWith('@/')) base = join(SRC_ROOT, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
  else return null // bare specifier → npm dep
  for (const ext of EXTS) if (existsSync(base + ext)) return base + ext
  if (existsSync(base) && !existsSync(base + '.ts')) {
    for (const ext of EXTS) if (existsSync(join(base, 'index' + ext))) return join(base, 'index' + ext)
  }
  if (existsSync(base) && base.endsWith('.json')) return base
  return null
}

/** Drop comments so prose like "derived from 'a recipe'" can't be mistaken
 *  for an import. String and template literals are preserved — the import
 *  specifiers we're after live in them. */
function stripComments(src) {
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') { const nl = src.indexOf('\n', i); if (nl < 0) break; out += '\n'; i = nl; continue }
    if (c === '/' && next === '*') { const end = src.indexOf('*/', i + 2); if (end < 0) break; i = end + 1; continue }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += c
      i++
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        if (src[i] === quote) break
        i++
      }
      continue
    }
    out += c
  }
  return out
}

// Statement-anchored so only real imports match. `[^'"]*?` cannot cross a
// string literal, which keeps multi-line `import { … } from 'x'` working
// without swallowing unrelated quotes.
const SPEC_PATTERNS = [
  /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
]

/** A module specifier has no whitespace and no trailing prose punctuation. */
const SPEC_SHAPE = /^(?:@[\w.-]+\/)?[\w.@/~-]+$/

function specifiersOf(text) {
  const clean = stripComments(text)
  const found = new Set()
  for (const re of SPEC_PATTERNS) {
    re.lastIndex = 0
    for (const m of clean.matchAll(re)) {
      const spec = m[1].trim()
      if (SPEC_SHAPE.test(spec)) found.add(spec)
    }
  }
  return [...found]
}

function collectClosure(entryFiles, extraSources = []) {
  const seen = new Set()
  const bare = new Set()
  const missing = new Set()
  const queue = []

  const scan = (text, fromPath) => {
    for (const spec of specifiersOf(text)) {
      const r = resolveSpec(spec, fromPath)
      if (r) { if (!seen.has(r)) queue.push(r) }
      else if (!spec.startsWith('.') && !spec.startsWith('@/')) bare.add(spec)
      else missing.add(`${spec} (from ${relative(SRC_ROOT, fromPath)})`)
    }
  }

  // Virtual entries: trimmed route text that isn't on disk yet. Scanned
  // BEFORE the Next shims are swapped in, so `../runtime/after` — which
  // only exists in the generated repo — never looks like a missing file.
  for (const { text, path } of extraSources) scan(text, path)
  for (const f of entryFiles) queue.push(f)

  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (file.endsWith('.json')) continue
    scan(readFileSync(file, 'utf8'), file)
  }
  return { files: [...seen], bare: [...bare], missing: [...missing] }
}

/** npm package name from a bare specifier (`@scope/pkg/sub` → `@scope/pkg`). */
function pkgName(spec) {
  if (spec.startsWith('node:')) return null
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

// ── file templates ───────────────────────────────────────────────────────

const tpl = {
  after: () => `import { currentSmsWork, durableAfter } from '../lib/sms/durable-work'
// Next's \`after()\` runs work once the response is flushed. Nest has no
// equivalent, and the receptionist relies on it for every heavy turn
// (measure, estimate, dispatch) — so the shim runs the callback on the
// next tick and keeps the process alive until it settles.
// ponytail: in-process fire-and-forget, same as Next on a single node.
// Swap for a real queue (BullMQ/SQS) if a turn must survive a redeploy.
const inflight = new Set<Promise<unknown>>()

export function after(fn: () => unknown | Promise<unknown>): void {
  if (currentSmsWork()) { durableAfter(fn); return }
  const p = Promise.resolve()
    .then(fn)
    .catch((e) => {
      console.error('[runtime/after] background task threw', e)
    })
    .finally(() => {
      inflight.delete(p)
    })
  inflight.add(p)
}

/** Await every queued background task — used by tests and graceful shutdown. */
export async function drainAfter(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight])
}
`,

  webRequest: () => `import type { Request as ExpressRequest } from 'express'

/** Express request → WHATWG Request, so the copied Next route handlers run
 *  unmodified. The raw body is required: Twilio signs the exact bytes. */
export function toWebRequest(req: ExpressRequest & { rawBody?: Buffer }): Request {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol ?? 'http'
  const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? 'localhost'
  const url = \`\${proto}://\${host}\${req.originalUrl ?? req.url}\`

  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue
    headers.set(k, Array.isArray(v) ? v.join(', ') : String(v))
  }

  const method = (req.method ?? 'GET').toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const body = hasBody ? (req.rawBody ?? Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}))) : undefined

  return new Request(url, { method, headers, body: body as unknown as BodyInit, duplex: 'half' } as RequestInit)
}

/** Copy a WHATWG Response onto the Express response. */
export async function sendWebResponse(webRes: Response, res: import('express').Response): Promise<void> {
  webRes.headers.forEach((value, key) => res.setHeader(key, value))
  const buf = Buffer.from(await webRes.arrayBuffer())
  res.status(webRes.status).send(buf)
}
`,

  requiredEnv: (required) => `// Env vars this service cannot start a turn without.
// Generated from what the copied code actually reads — see
// scripts/export-receptionist.mjs in the monorepo.
export const REQUIRED_ENV = ${JSON.stringify(required, null, 2)} as const

export function missingEnv(): string[] {
  return REQUIRED_ENV.filter((k) => !process.env[k])
}
`,

  main: (trade, cfg) => `import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe, Logger } from '@nestjs/common'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { drainAfter } from './runtime/after'
import { missingEnv } from './config/required-env'

// NOTE: AppModule is imported DYNAMICALLY inside bootstrap(), never at the
// top of this file. Several vendored modules construct their Supabase client
// at module scope, so merely importing the graph with no config throws
// "supabaseUrl is required." before any of our code runs — on Railway that
// is a crash-loop with an unreadable stack trace. Validating first and
// importing second turns that into one clear log line.

const TRADE = '${trade}'
process.env.SMS_WORKER_SERVICE = TRADE

// Load .env / .env.local into process.env BEFORE anything reads it. Nest's
// ConfigModule would do this, but it only runs once AppModule is imported —
// which is after the config check below, so a valid local .env would still
// look "missing". Platform-injected variables always win over the files:
// on Railway there is no .env in the image at all, and locally there is no
// platform to override.
{
  const platform = { ...process.env }
  for (const file of ['.env', '.env.local']) {
    try { process.loadEnvFile(file) } catch { /* absent is fine */ }
  }
  Object.assign(process.env, platform)
}

// TWO base URLs, deliberately separate:
//
//   APP_URL          — the PUBLIC WEBSITE (quotemax.com.au). Every customer
//                      link this service texts (\`/q/*\` quote pages, booking,
//                      payment) is built on it, so it must point where those
//                      pages are actually served.
//   ENGINE_BASE_URL  — where the intake/estimate ENGINES run. This service
//                      serves them itself, so it defaults to ITSELF via
//                      loopback. Keeping the engines in-service also keeps
//                      the CRON_SECRET handshake within one process's env —
//                      no cross-deployment secret alignment to get wrong.
//
// 127.0.0.1, not localhost: the app binds 0.0.0.0 (IPv4); in some containers
// Node resolves localhost to ::1 and the self-call would refuse.

if (!process.env.ENGINE_BASE_URL) {
  process.env.ENGINE_BASE_URL = \`http://127.0.0.1:\${process.env.PORT ?? ${cfg.port}}\`
}

async function bootstrap() {
  const configuredPublicOrigin = process.env.PUBLIC_WEB_ORIGIN?.trim() || process.env.APP_URL?.trim()
  const { publicWebOrigin } = await import('./lib/sms/public-origin')
  let invalidPublicOrigin = false
  try {
    const origin = publicWebOrigin()
    // Normalise legacy readers before module-scope URL constants are loaded.
    process.env.PUBLIC_WEB_ORIGIN = origin
    process.env.APP_URL = origin
    process.env.NEXT_PUBLIC_APP_URL = origin
  } catch { invalidPublicOrigin = true }
  const missing = missingEnv()
  if (!configuredPublicOrigin) missing.push('PUBLIC_WEB_ORIGIN')
  if (invalidPublicOrigin) missing.push('VALID_PUBLIC_WEB_ORIGIN')
  if (missing.length) {
    // Exit before importing the app graph, with something an operator can act
    // on. Railway shows this verbatim in deploy logs.
    const log = new Logger('bootstrap')
    log.error(\`Cannot start the \${TRADE} receptionist — missing required configuration:\`)
    for (const key of missing) log.error(\`  · \${key}\`)
    log.error('Set these as service variables, then redeploy. See .env.example.')
    process.exit(1)
  }

  const { AppModule } = await import('./app.module')

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Twilio signs the raw request bytes — the validator needs them intact.
    rawBody: true,
  })

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
  app.enableShutdownHooks()

  const config = new DocumentBuilder()
    .setTitle(\`QuoteMax \${TRADE} receptionist\`)
    .setDescription(
      '${cfg.blurb}\\n\\n' +
        'Isolated service: this API owns the ${trade} trade only. ' +
        'POST /api/sms/inbound is the Twilio webhook (signature-validated). ' +
        'POST /api/receptionist/simulate is the same pipeline with a JSON body for testing.',
    )
    .setVersion(process.env.npm_package_version ?? '0.1.0')
    .addTag('receptionist', 'SMS turn handling for ${trade}')
    .addTag('intake', 'Intake engine — free text + photos → structured Intake')
    .addTag('estimate', 'Estimation engine — Intake → grounded G/B/B quote')
    .addTag('health', 'Liveness and dependency checks')
    .addApiKey({ type: 'apiKey', name: 'x-sim-key', in: 'header' }, 'sim-key')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'cron-secret')
    .build()

  const doc = SwaggerModule.createDocument(app, config)
  SwaggerModule.setup('api/docs', app, doc, {
    swaggerOptions: { persistAuthorization: true },
    customSiteTitle: \`QuoteMax \${TRADE} receptionist API\`,
  })

  // Railway injects PORT and routes to the container's published port.
  // 0.0.0.0 is required — binding to localhost makes the container
  // unreachable from Railway's proxy and the deploy healthcheck fails.
  const port = Number(process.env.PORT ?? ${cfg.port})
  const server = await app.listen(port, '0.0.0.0')
  const { startWorkers } = await import('./runtime/workers')
  const stopWorkers = startWorkers()
  // A roofing measure turn can run ~200-300s; don't let the HTTP layer
  // cut the request out from under it.
  server.setTimeout(Number(process.env.HTTP_TIMEOUT_MS ?? 310_000))

  // Railway sends SIGTERM on redeploy. Drain in-flight background work
  // (an after() turn mid-measure) before the process goes away.
  process.on('SIGTERM', async () => {
    stopWorkers()
    await drainAfter()
    await app.close()
  })

  const log = new Logger('bootstrap')
  log.log(\`\${TRADE} receptionist on :\${port} — docs at /api/docs\`)
  log.log(\`APP_URL=\${process.env.APP_URL ?? '(unset — self-calls will fail)'}\`)
}

void bootstrap()
`,

  appModule: () => `import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ReceptionistModule } from './receptionist/receptionist.module'
import { IntakeModule } from './intake/intake.module'
import { EstimateModule } from './estimate/estimate.module'
import { WebModule } from './web/web.module'
import { HealthController } from './health/health.controller'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    ReceptionistModule,
    IntakeModule,
    EstimateModule,
    // The browser-facing surface: home, documentation, API explorer,
    // sandbox and keys — see src/web/.
    WebModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
`,

  receptionistModule: () => `import { Module } from '@nestjs/common'
import { ReceptionistController } from './receptionist.controller'

@Module({ controllers: [ReceptionistController] })
export class ReceptionistModule {}
`,

  receptionistController: (trade) => `import {
  BadGatewayException, Body, Controller, ForbiddenException, Headers, Post, Req, Res,
} from '@nestjs/common'
import { ApiBody, ApiExcludeEndpoint, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger'
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express'
import twilio from 'twilio'
import { POST as inboundRoute } from './inbound.route'
import { toWebRequest, sendWebResponse } from '../runtime/web-request'
import { SimulateTurnDto } from './dto/simulate-turn.dto'

const SIM_ENABLED = process.env.SMS_SIMULATE_ENABLED === '1'

@ApiTags('receptionist')
@Controller('api')
export class ReceptionistController {
  /** The live Twilio webhook. Body is form-encoded and signature-checked
   *  inside the route — Swagger can't drive this one, use /simulate. */
  @Post('sms/inbound')
  @ApiExcludeEndpoint()
  async inbound(
    @Req() req: ExpressRequest & { rawBody?: Buffer },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const webRes = await inboundRoute(toWebRequest(req))
    await sendWebResponse(webRes, res)
  }

  /** Same pipeline, JSON in — this is the endpoint to drive from Swagger.
   *  Guarded: it can send real SMS and mint real quotes. */
  @Post('receptionist/simulate')
  @ApiSecurity('sim-key')
  @ApiOperation({
    summary: 'Run one ${trade} receptionist turn (test harness)',
    description:
      'Synthesises a Twilio webhook from JSON and runs the identical handler. ' +
      'Requires SMS_SIMULATE_ENABLED=1 and a matching x-sim-key header. ' +
      'WARNING: sends real SMS and writes real rows when pointed at live credentials.',
  })
  @ApiBody({ type: SimulateTurnDto })
  @ApiResponse({ status: 202, description: 'Turn accepted; reply is dispatched in the background.' })
  @ApiResponse({ status: 403, description: 'Simulation disabled or bad x-sim-key.' })
  async simulate(
    @Body() dto: SimulateTurnDto,
    @Headers('x-sim-key') simKey: string | undefined,
    @Req() req: ExpressRequest,
  ): Promise<{ accepted: true; trade: string }> {
    const expected = process.env.SIM_API_KEY
    if (!SIM_ENABLED || !expected || simKey !== expected) {
      throw new ForbiddenException('simulation disabled — set SMS_SIMULATE_ENABLED=1 and a matching SIM_API_KEY')
    }

    const form = new URLSearchParams({
      From: dto.from,
      To: dto.to,
      Body: dto.body,
      MessageSid: dto.messageSid ?? \`SM\${Date.now().toString(36)}\${Math.random().toString(36).slice(2, 10)}\`,
      NumMedia: String(dto.mediaUrls?.length ?? 0),
    })
    dto.mediaUrls?.forEach((url, i) => {
      form.set(\`MediaUrl\${i}\`, url)
      form.set(\`MediaContentType\${i}\`, dto.mediaContentTypes?.[i] ?? 'application/octet-stream')
    })

    // Chained proxies can comma-join x-forwarded-proto; undici lowercases
    // the hostname when the Request resolves req.url — match both here or
    // the signed string differs from what the route validates against.
    const proto = ((req.headers['x-forwarded-proto'] as string) ?? 'http').split(',')[0].trim()
    const host = (req.headers.host ?? 'localhost').toLowerCase()
    // The route validates X-Twilio-Signature unconditionally — there is no
    // bypass, and adding one would weaken the real webhook. So SIGN the
    // synthetic request with this service's own auth token; the route then
    // verifies it exactly as it would a genuine Twilio callback. The route
    // sees no host/x-forwarded-host header on a synthetic Request, so it
    // validates against req.url — the same string signed here.
    const url = \`\${proto}://\${host}/api/sms/inbound\`
    const signature = twilio.getExpectedTwilioSignature(
      process.env.TWILIO_AUTH_TOKEN ?? '',
      url,
      Object.fromEntries(form.entries()),
    )
    const webReq = new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
        'x-quotemax-simulated': '1',
        ...(dto.turnId ? { 'x-quotemax-turn-id': dto.turnId } : {}),
      },
      body: form.toString(),
    })

    // Surface a rejection instead of swallowing it: a 403 here means the
    // signing above disagreed with the route's validation (bad/absent
    // TWILIO_AUTH_TOKEN), and "accepted" would be a lie.
    const routeRes = await inboundRoute(webReq)
    if (routeRes.status < 200 || routeRes.status >= 300) {
      const detail = await routeRes.text().catch(() => '')
      throw new BadGatewayException(
        \`inbound route rejected the synthetic webhook (\${routeRes.status}): \${detail.slice(0, 160)}\`,
      )
    }
    return { accepted: true, trade: '${trade}' }
  }
}
`,

  simulateDto: (trade) => `import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator'

export class SimulateTurnDto {
  @ApiProperty({ example: '+61400000001', description: "Customer's mobile, E.164." })
  @IsString()
  @Matches(/^\\+[1-9]\\d{6,15}$/, { message: 'from must be E.164, e.g. +61400000001' })
  from!: string

  @ApiProperty({ example: '+61481613464', description: "The tenant's provisioned SMS number, E.164. Resolves the tenant." })
  @IsString()
  @Matches(/^\\+[1-9]\\d{6,15}$/, { message: 'to must be E.164, e.g. +61481613464' })
  to!: string

  @ApiProperty({ example: ${trade === 'roofing'
    ? "'Hi, after a quote to re-roof my place at 12 Example St, Brisbane'"
    : trade === 'painting'
      ? "'Looking for a quote to repaint the outside of my house'"
      : trade === 'solar'
        ? "'Keen for a solar quote for my place'"
        : trade === 'plumbing'
          ? "'Hot water system is leaking, need a quote'"
          : "'Need 4 double GPOs installed in my garage'"}, description: 'The inbound SMS text.' })
  @IsString()
  @MaxLength(1600)
  body!: string

  @ApiPropertyOptional({ description: 'Twilio MessageSid. Omit and one is generated — reusing a Sid exercises the dedup path.' })
  @IsOptional()
  @IsString()
  messageSid?: string

  @ApiPropertyOptional({ type: [String], description: 'MMS photo URLs attached to the message.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaUrls?: string[]

  @ApiPropertyOptional({ type: [String], description: 'Provider MIME types aligned with mediaUrls.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  mediaContentTypes?: string[]

  @ApiPropertyOptional({ description: 'Durable front-desk turn ID.' })
  @IsOptional()
  @IsUUID()
  turnId?: string
}
`,

  intakeModule: () => `import { Module } from '@nestjs/common'
import { IntakeController } from './intake.controller'

@Module({ controllers: [IntakeController] })
export class IntakeModule {}
`,

  intakeController: () => `import { Controller, Post, Req, Res } from '@nestjs/common'
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger'
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express'
import { POST as structureRoute } from './structure.route'
import { toWebRequest, sendWebResponse } from '../runtime/web-request'

/** The intake engine. Internal-only: guarded by CRON_SECRET inside the
 *  route (isCronAuthorised). Path is kept at /api/intake/structure so the
 *  receptionist's existing self-call resolves against APP_URL unchanged. */
@ApiTags('intake')
@Controller('api/intake')
export class IntakeController {
  @Post('structure')
  @ApiSecurity('cron-secret')
  @ApiOperation({
    summary: 'Structure a raw intake (Opus vision + Zod) and hand off to estimation',
    description:
      'Internal route. Requires Authorization: Bearer $CRON_SECRET. ' +
      'Accepts { intake_id } or a raw transcript payload; writes the structured intake, ' +
      'embeds it, then fires the estimate draft.',
  })
  async structure(
    @Req() req: ExpressRequest & { rawBody?: Buffer },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const webRes = await structureRoute(toWebRequest(req))
    await sendWebResponse(webRes, res)
  }
}
`,

  estimateModule: () => `import { Module } from '@nestjs/common'
import { EstimateController } from './estimate.controller'

@Module({ controllers: [EstimateController] })
export class EstimateModule {}
`,

  estimateController: () => `import { Controller, Post, Req, Res } from '@nestjs/common'
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger'
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express'
import { POST as draftRoute } from './draft.route'
import { toWebRequest, sendWebResponse } from '../runtime/web-request'

/** The estimation engine. Internal-only (CRON_SECRET). Every price still
 *  comes from a tool call and is checked by the grounding validator —
 *  a failure downgrades the whole quote to the inspection route. */
@ApiTags('estimate')
@Controller('api/estimate')
export class EstimateController {
  @Post('draft')
  @ApiSecurity('cron-secret')
  @ApiOperation({
    summary: 'Draft a grounded G/B/B quote from a structured intake',
    description:
      'Internal route. Requires Authorization: Bearer $CRON_SECRET. ' +
      'Runs RAG + tool-calling estimation, validates every line item against the ' +
      'pricing book, mints Stripe sessions and dispatches the quote SMS.',
  })
  async draft(
    @Req() req: ExpressRequest & { rawBody?: Buffer },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const webRes = await draftRoute(toWebRequest(req))
    await sendWebResponse(webRes, res)
  }
}
`,

  healthController: (trade) => `import { Controller, ForbiddenException, Get, Headers, Res } from '@nestjs/common'
import { timingSafeEqual } from 'node:crypto'
import type { Response } from 'express'
import { missingEnv } from '../config/required-env'
import { receptionistReadiness, releaseFingerprint } from '../runtime/readiness'

@Controller('api/health')
export class HealthController {
  @Get()
  live() { return { ok: true, trade: '${trade}', uptimeSeconds: Math.round(process.uptime()), release: releaseFingerprint() } }

  @Get('deep')
  config(@Res({ passthrough: true }) res: Response) {
    const missing = missingEnv()
    if (missing.length) res.status(503)
    return { ok: missing.length === 0, level: 'configuration', trade: '${trade}', missing, release: releaseFingerprint() }
  }

  @Get('ready')
  async ready(@Headers('x-sim-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const expected = process.env.SIM_API_KEY
    const a = Buffer.from(expected ?? ''), b = Buffer.from(key ?? '')
    if (!expected || !key || a.length !== b.length || !timingSafeEqual(a,b)) throw new ForbiddenException('Readiness authentication required')
    const result = await receptionistReadiness('${trade}')
    if (!result.ok) res.status(503)
    return result
  }
}
`,

  tsconfig: () => JSON.stringify({
    compilerOptions: {
      module: 'commonjs',
      target: 'ES2022',
      // Matches the monorepo. ES2022 is too old for the copied code —
      // lib/solar reaches for Array.prototype.toSorted (ES2023). Node 20+
      // has it at runtime; this just tells tsc that.
      lib: ['ESNext', 'DOM', 'DOM.Iterable'],
      declaration: false,
      removeComments: false,
      emitDecoratorMetadata: true,
      experimentalDecorators: true,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      sourceMap: true,
      outDir: './dist',
      baseUrl: './',
      incremental: true,
      skipLibCheck: true,
      strict: true,
      // The copied lib/ is byte-identical to the monorepo, which does not
      // run these two. Turning them on here would fail on vendored code we
      // deliberately do not edit.
      noUnusedLocals: false,
      noUnusedParameters: false,
      forceConsistentCasingInFileNames: true,
      paths: {
        '@/*': ['src/*'],
        // Nest emits CommonJS, so TS resolves stripe's CJS typings — which
        // `export = StripeConstructor` and expose the class only as a
        // namespace member, breaking `let s: Stripe`. The monorepo uses
        // bundler resolution and gets the ESM d.ts (`export default Stripe`)
        // instead. Same API, same runtime require() — just the typings the
        // vendored lib/stripe/client.ts is written against.
        // ponytail: pinned because the dep version is pinned; revisit if
        // stripe ships a single unified d.ts.
        stripe: ['node_modules/stripe/esm/stripe.esm.node.d.ts'],
      },
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist', '**/*.test.ts'],
  }, null, 2) + '\n',

  nestCli: () => JSON.stringify({
    $schema: 'https://json.schemastore.org/nest-cli',
    collection: '@nestjs/schematics',
    sourceRoot: 'src',
    compilerOptions: { deleteOutDir: true, tsConfigPath: 'tsconfig.json' },
  }, null, 2) + '\n',

  // Ignore every .env variant, then re-admit the blank template. The
  // catch-all matters: fill-receptionist-env.mjs writes .env.bak.<n>
  // backups that contain real secrets, and listing only `.env` left those
  // sitting untracked-but-committable.
  gitignore: () => `node_modules/
dist/
.env*
!.env.example
*.tsbuildinfo
run.log
.DS_Store
`,

  // Debian slim, NOT Alpine. sharp pulls a prebuilt native binary and the
  // glibc build (@img/sharp-linux-x64) is the well-trodden one; Alpine needs
  // the musl variant plus libc6-compat and fails in subtler ways. The image
  // is bigger; the deploy is boring. That trade is correct here.
  dockerfile: (trade) => `# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────
# qm-${trade}-receptionist — multi-stage build for Railway (or any Docker host)
#   docker build -t qm-${trade}-receptionist .
#   docker run -p 8080:8080 --env-file .env.local qm-${trade}-receptionist
# ─────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production

# ─── Stage 1: install + build ────────────────────────────────────────
# NODE_ENV=development so npm ci installs devDependencies — the build
# needs @nestjs/cli, typescript and tsc-alias.
FROM base AS builder
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json nest-cli.json Dockerfile .dockerignore railway.json .nvmrc release-manifest.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build
# Drop devDependencies in place so the runtime stage copies a lean tree
# and we never pay for a second install.
RUN npm prune --omit=dev

# ─── Stage 2: runtime ────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

# Non-root. node:*-slim ships a \`node\` user (uid 1000) already.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json /app/release-manifest.json /app/build-attestation.json ./

USER node

# Railway overrides PORT at runtime; main.ts binds 0.0.0.0 either way.
ENV PORT=8080
EXPOSE 8080

# Exec form: node is PID 1 and receives SIGTERM directly, so the
# graceful-shutdown hook in main.ts actually runs on redeploy.
CMD ["node", "dist/main.js"]
`,

  dockerignore: () => `node_modules
dist
.git
.gitignore
.env
.env.*
!.env.example
*.tsbuildinfo
*.md
.DS_Store
`,

  railwayJson: () => JSON.stringify({
    $schema: 'https://railway.com/railway.schema.json',
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    deploy: {
      // Liveness, not readiness — see src/health/health.controller.ts.
      // A missing env var should not wedge the deploy; curl /api/health/deep
      // after the first boot to confirm configuration.
      healthcheckPath: '/api/health',
      healthcheckTimeout: 300,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      numReplicas: 1,
    },
  }, null, 2) + '\n',
}

// ── env template ─────────────────────────────────────────────────────────

// Env vars the service cannot start a turn without. Everything else the
// code reads is optional (a provider, a feature flag) and is listed in the
// generated "also referenced" block so nothing is invisible.
const REQUIRED_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'CRON_SECRET',
  'APP_URL',
]

/** Every `process.env.NAME` read anywhere under a written src/ tree.
 *  Scans the OUTPUT directory rather than the source closure, so the
 *  generated scaffolding (main.ts, controllers, DTOs) is included too —
 *  scanning only the copied lib missed PORT, SIM_API_KEY and friends. */
function envVarsUsed(srcDir) {
  const found = new Set()
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!p.endsWith('.ts')) continue
      const text = readFileSync(p, 'utf8')
      for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})\b/g)) found.add(m[1])
      for (const m of text.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g)) found.add(m[1])
    }
  }
  walk(srcDir)
  return [...found].sort()
}

// Every group below is keyed to variables the copied code ACTUALLY reads —
// the generator cross-checks against the process.env scan and refuses to
// emit a name nothing references, so this file can't drift into listing
// knobs that do nothing.
const ENV_GROUPS = [
  {
    title: 'REQUIRED — the service refuses to boot without these',
    note: 'main.ts validates these before importing the app and exits listing\nwhatever is missing. Set all of them on Railway.',
    vars: {
      NEXT_PUBLIC_SUPABASE_URL: 'Supabase project URL. Named NEXT_PUBLIC_* only because the code is copied verbatim from the Next monorepo — this service is server-only and nothing here is public.',
      SUPABASE_SERVICE_ROLE_KEY: 'Supabase service-role key. SECRET. Bypasses RLS; tenancy is enforced in app code.',
      ANTHROPIC_API_KEY: 'Claude API key — powers the receptionist dialog and the estimator.',
      TWILIO_ACCOUNT_SID: 'Twilio account SID.',
      TWILIO_AUTH_TOKEN: 'Twilio auth token. SECRET. Also what inbound webhook signature validation is keyed on — absent means inbound requests cannot be verified.',
      CRON_SECRET: 'Shared secret for this service\'s internal self-calls to /api/intake/structure and /api/estimate/draft. Absent in production ⇒ the pipeline FAILS CLOSED and no quotes are produced.',
    },
  },
  {
    title: 'Railway sets these — leave blank',
    note: 'Injected by the platform at runtime. Setting them by hand usually breaks something.',
    vars: {
      PORT: 'Injected by Railway. main.ts binds 0.0.0.0 on this port.',
      RAILWAY_PUBLIC_DOMAIN: 'Injected API origin. Never used as the public quote origin.',
      APP_URL: 'Required public WEBSITE origin serving all /q pages. Must differ from the API/service origin.',
      NEXT_PUBLIC_APP_URL: 'Legacy alias; must match APP_URL when configured.',
      HTTP_TIMEOUT_MS: 'Server socket timeout. Default 310000 — a roofing measure turn can run 200-300s.',
      NODE_ENV: 'Set to production by the Dockerfile.',
    },
  },
  {
    title: 'Messaging — outbound SMS/WhatsApp and tradie alerts',
    vars: {
      TWILIO_SMS_NUMBER: 'Fallback outbound sender when a tenant has no provisioned number.',
      TWILIO_PHONE_NUMBER: 'Legacy alias for the fallback sender.',
      TWILIO_WHATSAPP_FROM: 'WhatsApp sender (whatsapp:+61...). Unset ⇒ SMS only, no WhatsApp fallback.',
      TRADIE_NOTIFY_NUMBER: 'Catch-all number for tradie notifications when a tenant has no owner_mobile. Unset ⇒ those alerts go NOWHERE (known gap).',
      TRADIE_NOTIFY_WHATSAPP: 'WhatsApp equivalent of the above.',
      SMS_QUOTE_PDF_MMS: '1 = attach the quote PDF as MMS alongside the link.',
      TEST_CUSTOMER_NUMBERS: 'Comma-separated numbers treated as test traffic.',
    },
  },
  {
    title: 'Payments',
    vars: {
      STRIPE_SECRET_KEY: 'Stripe secret key. Use a TEST key unless you mean it — this mints real deposit links.',
      BILLING_ENFORCEMENT_ENABLED: '1 = enforce per-tenant plan limits.',
    },
  },
  {
    title: 'Quote documents (PDF)',
    vars: {
      GOTENBERG_URL: 'Gotenberg HTML→PDF service URL. Unset ⇒ no PDF is generated; the HTML quote page still works.',
      FULL_QUOTE_DOC: '1 = render the long-form quote document.',
    },
  },
  {
    title: 'Receptionist behaviour',
    vars: {
      SMS_LLM_RECEPTIONIST_ENABLED: 'Default ON. 0 = kill switch for ALL tenants, falling back to the deterministic state machine. A comma-separated tenant-id list narrows it to a pilot.',
      SMS_ROOFING_ENABLED: 'No-tenant fallback only. The real gate is tenants.trades[].',
      SMS_PAINTING_ENABLED: 'No-tenant fallback only. The real gate is tenants.trades[].',
      WP9_PRODUCT_OPTIONS: '1 = offer mid-conversation product choices.',
      DETERMINISTIC_BOM: '1 = prefer deterministic assembly/BOM pricing over an LLM draft.',
      PRICE_HISTORY_HINT: '1 = feed the tradie\'s past prices to the estimator as a hint.',
      FORCE_GAS_HWS_SITE_VISIT: '1 = always route gas hot-water jobs to an inspection.',
      SOLAR_PREMIUM_QUOTE: '1 = use the premium solar quote template.',
      TENANT_FILESTORE_ENABLED: '1 = enable the per-tenant document store used for KB grounding.',
      PLATFORM_ADMIN_USER_IDS: 'Comma-separated admin user ids.',
    },
  },
  {
    title: 'Quote accuracy — RAG over past jobs (recommended)',
    note: 'Unset ⇒ retrieval is stubbed and the estimator loses its similar-past-\nquote context. Quotes still generate, just with less grounding.',
    vars: {
      VOYAGE_API_KEY: 'Voyage embeddings — powers similar-past-quote retrieval.',
      VOYAGE_EMBED_MODEL: 'Override the embedding model.',
      VOYAGE_RERANK_MODEL: 'Override the Voyage rerank model.',
      COHERE_API_KEY: 'Cohere reranker.',
      COHERE_RERANK_MODEL: 'Override the Cohere rerank model.',
      RAG_RERANK_PROVIDER: 'cohere | voyage | unset.',
      RAG_DISABLED: '1 = turn retrieval off entirely.',
      RAG_RERANK_DISABLED: '1 = retrieve but skip reranking.',
      RAG_RERANK_FALLBACK: '1 = fall back to raw retrieval when the reranker errors.',
    },
  },
  {
    title: 'Swagger test harness',
    note: '/api/receptionist/simulate runs the REAL pipeline — real SMS, real rows,\nreal Stripe links. Leave disabled unless pointed at a test tenant.',
    vars: {
      SMS_SIMULATE_ENABLED: '1 = enable POST /api/receptionist/simulate.',
      SIM_API_KEY: 'Required x-sim-key header value for that endpoint. SECRET.',
    },
  },
  {
    title: 'Web surface — operator login for /sandbox and /keys',
    note: 'The public pages (home, documentation, API explorer) need nothing.\nUnset password ⇒ the operator pages stay locked; boot is unaffected.',
    vars: {
      WEB_ADMIN_PASSWORD: 'Operator password for the web login. SECRET.',
      WEB_SESSION_SECRET: 'Optional HMAC secret for the session cookie. Derived from the password when unset; set it to survive password rotation.',
      SANDBOX_WAIT_MS: 'How long the web sandbox waits for a pipeline reply before handing back. Default 150000.',
    },
  },
  {
    title: 'Address + property measurement',
    vars: {
      GOOGLE_MAPS_API_KEY: 'Geocoding, static maps and street view.',
      GOOGLE_ADDRESS_VALIDATION_API_KEY: 'AU address verification during the SMS turn.',
      GOOGLE_ADDRESS_VALIDATION_API_URL: 'Override the validation endpoint.',
      GEOSCAPE_API_KEY: 'Geoscape — the primary roof measurement provider.',
      GEOSCAPE_API_BASE_URL: 'Override the Geoscape base URL.',
      GOOGLE_SOLAR_API_KEY: 'Google Solar building insights — roof facets, and wall area for painting.',
      GOOGLE_SOLAR_API_BASE_URL: 'Override the Solar API base URL.',
      PROPRADAR_API_KEY: 'PropRadar — secondary property data.',
      PROPRADAR_API_BASE_URL: 'Override the PropRadar base URL.',
      PROPRADAR_API: 'Legacy PropRadar endpoint alias.',
      PROPRADAR_ENRICHMENT: '1 = enrich measurements with PropRadar data.',
      ROOFING_PROVIDER: 'Primary measurement provider. Default geoscape.',
      ROOFING_SOLAR_ENRICHMENT: '1 = detect existing solar panels on the roof.',
      SOLAR_EXPANDED_COVERAGE: '1 = widen the Google Solar coverage gate.',
      ROOFING_LAYOUT_MODEL: 'Model used for roof layout planning.',
      ROOFING_VISION_PROVIDER: 'Vision provider for roof photo analysis.',
      ROOFING_VISION_MODEL: 'Vision model for roof photo analysis.',
      TRADIE_NOTIFY_SELF_TEST: '1 = send a self-test notification on boot.',
    },
  },
  {
    title: 'Solar design cross-checks',
    vars: {
      OPENSOLAR_USERNAME: 'OpenSolar login for background proposal cross-checks.',
      OPENSOLAR_PASSWORD: 'OpenSolar password. SECRET.',
      OPENSOLAR_API_TOKEN: 'OpenSolar API token (alternative to username/password).',
      OPENSOLAR_ORG_ID: 'OpenSolar organisation id.',
      PYLON_ENABLED: '1 = enable Pylon cross-checks.',
      PYLON_API_KEY: 'Pylon API key.',
      PYLON_LEAD_PUSH_TENANTS: 'Comma-separated tenant ids to push leads for.',
    },
  },
  {
    title: 'Image generation and vision — all optional',
    note: 'Powers "after" renders, SMS preview images and photo classification.\nEvery one is optional: unset simply means that provider is off.',
    vars: {
      IG_IMAGE_PROVIDER: 'Selector for the SMS preview/sample image provider.',
      GEMINI_API_KEY: 'Google Gemini — text, vision and image generation.',
      GEMINI_TEXT_MODEL: '', GEMINI_IMAGE_MODEL: '', GEMINI_VISION_MODEL: '', GEMINI_VERIFY_MODEL: '',
      GEMINI_IMAGE_ASPECT: '', GEMINI_IMAGE_SIZE: '', GEMINI_IMAGE_TEMPERATURE: '',
      GEMINI_IMAGE_THINKING_LEVEL: '', GEMINI_IMAGE_TOP_P: '',
      GEMINI_RETRY_ATTEMPTS: '', GEMINI_RETRY_BASE_MS: '', GEMINI_RETRY_MAX_DELAY_MS: '',
      HF_TOKEN: 'Hugging Face token — FLUX.1-Kontext "after" renders.',
      HUGGING_FACE_API_TOKEN: 'Alias for HF_TOKEN.',
      HF_IMAGE_PROVIDER: '', HF_IMAGE_MODEL: '', HF_IMAGE_TIMEOUT_MS: '', HF_VISION_MODEL: '',
      ROOFING_IMAGE_PROVIDER: 'Per-trade override for roofing "after" renders.',
      REPLICATE_API_TOKEN: 'Replicate — image generation fallback.',
      REPLICATE_IMAGE_MODEL: '', REPLICATE_IMAGE_RESOLUTION: '',
      STABILITY_API_KEY: 'Stability AI.',
      STABILITY_NIM_URL: '', STABILITY_IMAGE_MODE: '', STABILITY_IMAGE_STEPS: '',
      STABILITY_IMAGE_CFG_SCALE: '', STABILITY_IMAGE_NEGATIVE_PROMPT: '',
      CLOUDFLARE_ACCOUNT_ID: 'Cloudflare Workers AI — vision.',
      CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_WORKERS_AI_TOKEN: '',
      CLOUDFLARE_VISION_MODEL: '', CLOUDFLARE_CLAUDE_VISION: '',
      NVIDIA_API_KEY: 'NVIDIA NIM — vision.',
      PREVIEW_JUDGE_MODEL: 'Model that scores generated preview images.',
      PREVIEW_PROMPT_VERSION: '', PREVIEW_TWO_PASS: '', PREVIEW_VERIFY_LOOP: '',
      PREVIEW_VERIFY_MAX_RETRIES: '', WP4_RENDER_VERIFY: '',
      DISABLE_AI_SAMPLES: '1 = skip sample image generation entirely.',
      TRUST_VIDEO_AUTOGEN: '1 = auto-generate tradie trust videos.',
      TRUST_VIDEO_MODEL: '',
    },
  },
]

/** Build the .env body from the vars this trade's code actually reads. */
function envBody(trade, cfg, used) {
  const usedSet = new Set(used)
  const claimed = new Set()
  const lines = [
    `# ── QuoteMax ${trade} receptionist — environment ${'─'.repeat(Math.max(0, 24 - trade.length))}`,
    `# ${cfg.blurb}`,
    '#',
    '# Every name below is read by THIS service\'s code — generated by scanning',
    '# src/ for process.env reads, so nothing here is decorative.',
    '#',
    '# Railway: paste this whole file into the service\'s Variables → Raw Editor,',
    '# or set them one at a time with:  railway variables --set \'KEY=value\'',
    '#',
    '# NEVER commit a filled-in copy. .env is gitignored; .env.example is not.',
    '',
  ]

  for (const group of ENV_GROUPS) {
    const present = Object.keys(group.vars).filter((v) => usedSet.has(v) && !claimed.has(v))
    if (!present.length) continue
    present.forEach((v) => claimed.add(v))
    lines.push(`# ${'─'.repeat(70)}`)
    lines.push(`# ${group.title}`)
    if (group.note) for (const l of group.note.split('\n')) lines.push(`# ${l}`)
    lines.push(`# ${'─'.repeat(70)}`)
    for (const v of present) {
      const desc = group.vars[v]
      if (desc) for (const l of wrap(desc, 68)) lines.push(`# ${l}`)
      lines.push(`${v}=`)
    }
    lines.push('')
  }

  const leftover = [...usedSet].filter((v) => !claimed.has(v)).sort()
  if (leftover.length) {
    lines.push(`# ${'─'.repeat(70)}`)
    lines.push('# Other — read by the code but not yet categorised')
    lines.push(`# ${'─'.repeat(70)}`)
    for (const v of leftover) lines.push(`${v}=`)
    lines.push('')
  }
  return lines.join('\n')
}

function wrap(text, width) {
  const out = []
  let line = ''
  for (const word of text.split(' ')) {
    if ((line + ' ' + word).trim().length > width) { out.push(line.trim()); line = word }
    else line += ' ' + word
  }
  if (line.trim()) out.push(line.trim())
  return out
}

/** Names the trade boundary explicitly, because "isolated" does not mean
 *  "contains no other trade's code" — some shared modules genuinely serve
 *  every trade, and silently deleting them would change behaviour. */
function isolationDoc(trade, cfg, libFiles) {
  const rel = libFiles.map((f) => relative(SRC_ROOT, f).split(sep).join('/'))
  const other = ['roofing', 'painting'].filter((t) => !cfg.handlers.includes(t))
  const foreign = rel.filter((p) => other.some((t) => p.includes(`/${t}-`) || p.startsWith(`lib/${t}/`)))

  return `# Isolation boundary — qm-${trade}-receptionist

This service is deployed and versioned on its own. **Nothing you change
here can affect the other four receptionists.** That is the isolation
guarantee, and it holds unconditionally.

What follows is about tidiness, not safety.

## Yours to customise

| Layer | Path | Safe to edit? |
|---|---|---|
| HTTP surface, Swagger, DTOs | \`src/main.ts\`, \`src/*/[a-z]*.controller.ts\`, \`src/receptionist/dto/\` | Yes — hand-written for this repo, never overwritten. |
| Runtime shims | \`src/runtime/\` | Yes. |
| ${trade[0].toUpperCase() + trade.slice(1)} receptionist + engines | \`src/receptionist/inbound.route.ts\`, \`src/intake/structure.route.ts\`, \`src/estimate/draft.route.ts\` | Yes, but a re-sync overwrites them. |
| Domain code | \`src/lib/\` | Yes, but a re-sync overwrites it. Keep custom logic in the controllers. |

## Why other trades' files are still here

${foreign.length === 0
  ? `None are. This service's closure contains no ${other.join('/')} modules.`
  : `${foreign.length} file(s) belonging to ${other.join('/')} are present:

${foreign.map((p) => `- \`src/${p}\``).join('\n')}

They are **not dead code**. Three real reasons:

1. **Shared conversation state.** All five services read the same
   \`sms_conversations\` row. \`isActiveRoofingFlow\` / \`isActivePaintingFlow\`
   and the idle-state expiry helpers run in every service's spine so this
   one doesn't stomp a thread another service owns. Delete them and a
   multi-trade tenant gets crossed wires.
2. **One shared LLM conversation layer.** \`lib/sms/llm-receptionist.ts\`
   is a single Sonnet module covering every trade's tool schema.
3. **One shared quote renderer.** \`lib/quote/pdf.ts\` imports the roofing
   report builder because the PDF generator handles all trades.

Splitting these is a real refactor, not a delete. Until then they cost
disk, not correctness.`}

## The router in front of all five: qm-front-desk

Twilio points a phone number at exactly **one** URL, and a tenant has one
SMS number covering every trade they offer. So:

- **Single-trade tenant** → point the number straight at that service. Done.
- **Multi-trade tenant** → point the number at **qm-front-desk** (\`:3100\`,
  sibling repo). It identifies tenant + trade from the message and the live
  conversation state, then forwards the turn to this service over the signed
  \`/api/receptionist/simulate\` channel.

To accept the Front Desk's forwards, this service needs two variables set:
\`SMS_SIMULATE_ENABLED=1\` and \`SIM_API_KEY\` equal to the Front Desk's
\`RECEPTIONIST_SIM_KEY\`. The simulate controller signs the synthetic webhook
with this service's own \`TWILIO_AUTH_TOKEN\`, so the route's signature
validation stays fully closed — there is no bypass path.
`
}

function readme(trade, cfg, stats) {
  const Title = trade[0].toUpperCase() + trade.slice(1)
  return `# qm-${trade}-receptionist

${cfg.blurb}

This service owns **${trade} only**. It is a standalone NestJS API — no
runtime import dependency on the QuoteMax monorepo or on the other four
receptionists. It shares the database and public website contracts with them;
the release verifier checks that the candidate matches the canonical source.

## What's inside

| Piece | Path |
|---|---|
| ${Title} SMS receptionist | \`src/receptionist/inbound.route.ts\` |
| Intake engine | \`src/intake/structure.route.ts\` + \`src/lib/intake/\` |
| Estimation engine | \`src/estimate/draft.route.ts\` + \`src/lib/estimate/\` |
| Domain code | \`src/lib/\` (${stats.libFiles} files, ${stats.libLoc.toLocaleString()} lines) |

## Run it

\`\`\`bash
npm install
cp .env.example .env.local   # then fill it in
npm run start:dev
\`\`\`

Swagger UI: <http://localhost:${cfg.port}/api/docs>

## Endpoints

| Method | Path | Notes |
|---|---|---|
| POST | \`/api/sms/inbound\` | Twilio webhook. Form-encoded, signature-validated. Hidden from Swagger — drive \`/simulate\` instead. |
| POST | \`/api/receptionist/simulate\` | Same pipeline, JSON body. Needs \`SMS_SIMULATE_ENABLED=1\` + \`x-sim-key\`. |
| POST | \`/api/intake/structure\` | Intake engine. Internal — \`Authorization: Bearer $CRON_SECRET\`. |
| POST | \`/api/estimate/draft\` | Estimation engine. Internal — \`Authorization: Bearer $CRON_SECRET\`. |
| GET | \`/api/health\` | Liveness and release fingerprint. |
| GET | \`/api/health/deep\` | Configuration presence; this is not a capability test. |
| GET | \`/api/health/ready\` | Authenticated capability readiness, using \`x-sim-key\`. |

Two base URLs, deliberately separate: \`PUBLIC_WEB_ORIGIN\` (or \`APP_URL\`)
is the **public website** (\`https://quotemax.com.au\`) — customer links are
built on it. \`ENGINE_BASE_URL\` is where the intake/estimate engines run,
defaulting to this service itself over loopback — leave it unset unless you
are deliberately pointing the engines somewhere else.

## Deploy to Railway

Builds from the \`Dockerfile\` (Debian slim + Node 22). \`railway.json\` pins the
builder, the healthcheck and the restart policy, so a new service needs no
dashboard build configuration.

\`\`\`bash
railway init
railway up
\`\`\`

Then set variables — **\`railway variables --set 'KEY=value'\`**, one per key, or
paste them in the dashboard. The minimum to run a turn:

| Variable | Why |
|---|---|
| \`NEXT_PUBLIC_SUPABASE_URL\` | Database. Named \`NEXT_PUBLIC_*\` because the code is copied verbatim from the Next monorepo; it is server-only here. |
| \`SUPABASE_SERVICE_ROLE_KEY\` | Database. Secret. |
| \`ANTHROPIC_API_KEY\` | Dialog + estimation models. |
| \`TWILIO_ACCOUNT_SID\`, \`TWILIO_AUTH_TOKEN\` | Inbound signature validation and outbound sends. |
| \`CRON_SECRET\` | Guards the internal intake/estimate self-calls. **Absent in production ⇒ the pipeline fails closed and no quotes are produced.** |

You do **not** need to set \`PORT\` (Railway injects it) or \`ENGINE_BASE_URL\`
(defaults to this service over loopback). Set \`PUBLIC_WEB_ORIGIN\` or
\`APP_URL\` to the public website (\`https://quotemax.com.au\`). Startup rejects
a missing website origin, an API-only Railway hostname or a public/internal
origin collision, so broken customer links cannot become a default.

Before promotion, run the release verifier from the matching monorepo source:

\`\`\`bash
# After the candidate's package-lock generation and npm ci, before building:
node scripts/seal-receptionist-release.mjs /path/to/candidate
# Build the candidate, then verify the exact source and locked dependencies:
node scripts/verify-receptionist-release.mjs /path/to/built-candidate
\`\`\`

Then query \`/api/health/ready\` with \`x-sim-key\`. It requires migrations
${REQUIRED_RECEPTIONIST_MIGRATIONS.join(', ')}, matching website schemas, an enabled controlled tenant with pricing,
and recent synthetic evidence for this exact release hash. A configuration-only
\`/api/health/deep\` response does not establish quote capability. Railway's
liveness check is separate from the promotion decision.

Last, point the tenant's Twilio number's inbound SMS webhook at
\`https://<your-service>.up.railway.app/api/sms/inbound\`.

## Two things that will bite you

1. **\`/api/receptionist/simulate\` is not a mock.** It runs the real
   pipeline against whatever credentials are in \`.env.local\` — it sends
   real SMS and writes real rows. Point it at a test tenant, or leave
   \`SMS_SIMULATE_ENABLED=0\`.
2. **Twilio can only point a number at one URL.** Tenants have one SMS
   number covering all their trades, so a multi-trade tenant points the
   number at **qm-front-desk** (sibling repo, \`:3100\`), which identifies
   the trade per message and forwards the turn here over the signed
   \`/simulate\` channel — set \`SMS_SIMULATE_ENABLED=1\` and \`SIM_API_KEY\`
   equal to its \`RECEPTIONIST_SIM_KEY\`. Single-trade tenants can point
   straight here.

## Re-syncing from the monorepo

\`src/lib/\` is copied byte-identical from \`quotemate-automation\`. To pull
upstream fixes:

\`\`\`bash
node scripts/export-receptionist.mjs --out-root=/path/to/new-candidates ${trade}
\`\`\`

(run from the monorepo). Export refuses to overwrite an existing service
checkout. Review service-specific differences, port required behaviour into
canonical source, and build the new candidate with its locked dependencies.
Run the release contract and controlled behaviour tests before promotion.
`
}

// ── build one trade ──────────────────────────────────────────────────────

function buildTrade(trade, opts) {
  const cfg = TRADES[trade]
  const outDir = join(OUT_ROOT, `qm-${trade}-receptionist`)
  // Existing service customisations are inputs for a reviewed overlay, never
  // disposable generated output. Export candidates to a new directory.
  if (!opts.dry && existsSync(join(outDir, 'src'))) {
    const manifestFile = join(outDir,'release-manifest.json')
    if (!process.argv.includes('--refresh-candidate') || existsSync(join(outDir,'.git')) || !existsSync(manifestFile)) {
      throw new Error(`Refusing to overwrite existing sources: ${outDir}. Use --out-root=<new-candidate-directory>, then review the overlay.`)
    }
    const prior = JSON.parse(readFileSync(manifestFile,'utf8'))
    const actual = []
    const walk = (dir) => { for (const entry of readdirSync(dir,{withFileTypes:true})) {
      const path=join(dir,entry.name)
      if (entry.isDirectory()) walk(path); else actual.push(relative(outDir,path).split(sep).join('/'))
    } }
    walk(join(outDir,'src'))
    if (actual.length !== Object.keys(prior.generatedHashes ?? {}).length) throw new Error('Candidate has unreviewed added/deleted sources')
    for (const file of actual) {
      if (createHash('sha256').update(readFileSync(join(outDir,file))).digest('hex') !== prior.generatedHashes[file]) {
        throw new Error(`Candidate has an unreviewed edit: ${file}`)
      }
    }
    for (const [file, hash] of Object.entries(prior.buildInputHashes ?? {})) {
      if (createHash('sha256').update(readFileSync(join(outDir,file))).digest('hex') !== hash) {
        throw new Error(`Candidate has an unreviewed build input: ${file}`)
      }
    }
  }
  if (relative(OUT_ROOT, outDir).startsWith('..') || !outDir.startsWith(OUT_ROOT + sep)) throw new Error('Unsafe export target')

  // 1. Trim the three routes.
  const generated = []
  for (const r of ROUTES) {
    let src = readFileSync(join(SRC_ROOT, r.from), 'utf8')
    if (r.trim) {
      for (const [name, flag, key] of [
        ['handleRoofingTurn', 'roofingEnabled', 'roofing'],
        ['handlePaintingTurn', 'paintingEnabled', 'painting'],
      ]) {
        if (cfg.handlers.includes(key)) continue
        src = removeCallBlock(src, flag)
        src = removeHandler(src, name)
      }
      src = stripUnusedImports(src)
    }
    src = redirectEngineCalls(src)
    if (r.trim) {
      // Neither of these touches an import specifier, so both are safe to
      // apply before the closure scan.
      src = stripRetirementGuard(src)
      src = scopeSlotExtractor(src)
      src = gatePlanEstimation(src, trade)
    }
    // The dialog rewrite IS an import-specifier change, and it points at a
    // module this script GENERATES — which does not exist upstream. Scan the
    // closure with the original `@/lib/sms/dialog` specifier (the walker must
    // still pull dialog.ts in, since the wrapper imports it) and apply the
    // rewrite only to the text actually written, where it resolves.
    const written = r.trim ? scopeDialogToService(src) : src
    // Keep the pre-shim text for closure scanning; shim only on write.
    generated.push({ path: join(SRC_ROOT, r.from), out: r.to, raw: src, text: denextify(written, r.to) })
  }

  // 2. Closure over the trimmed routes + forced trade engines.
  const forced = [...(FORCE_INCLUDE[trade] ?? []), 'lib/sms/durable-work.ts', 'lib/sms/work-delivery-context.ts', 'lib/sms/public-origin.ts', 'lib/sms/scoped-fallback.ts', 'lib/sms/pricing-readiness.ts', 'lib/quote/public-schema.ts']
    .map((p) => join(SRC_ROOT, p))
    .filter((p) => existsSync(p))
  const { files, bare, missing } = collectClosure(
    forced,
    generated.map((g) => ({ text: g.raw, path: g.path })),
  )

  const libFiles = files.filter((f) => f.startsWith(join(SRC_ROOT, 'lib') + sep))
  const strays = files.filter((f) => !f.startsWith(join(SRC_ROOT, 'lib') + sep))

  // Every `next` reference in the closure must be the one `after()` import
  // that denextify() rewrites — otherwise this service would silently ship
  // a Next dependency it can't satisfy. Verify rather than assume.
  const AFTER_IMPORT = /^import\s*\{\s*after\s*\}\s*from\s*'next\/server'\s*$/m
  const stubbornNext = []
  for (const f of files) {
    if (f.endsWith('.json')) continue
    const text = readFileSync(f, 'utf8')
    const nextSpecs = specifiersOf(text).filter((s) => s === 'next' || s.startsWith('next/'))
    if (!nextSpecs.length) continue
    if (nextSpecs.length === 1 && nextSpecs[0] === 'next/server' && AFTER_IMPORT.test(text)) continue
    stubbornNext.push(`${relative(SRC_ROOT, f)} → ${nextSpecs.join(', ')}`)
  }

  const deps = new Set()
  for (const b of bare) {
    const n = pkgName(b)
    if (!n) continue
    if (n === 'next' && !stubbornNext.length) continue // fully shimmed away
    deps.add(n)
  }

  const libLoc = libFiles.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0)
  const stats = { libFiles: libFiles.length, libLoc, deps: [...deps].sort(), strays, missing, stubbornNext, envVars: 0, envCreated: false }

  if (opts.dry) return stats
  if (missing.length || stubbornNext.length) throw new Error(`Export dependency contract failed: ${missing.join(', ')} ${stubbornNext.join(', ')}`)

  // 3. Wipe only what we own, then write.
  mkdirSync(outDir, { recursive: true })

  if (process.argv.includes('--refresh-candidate') && existsSync(join(outDir,'release-manifest.json'))) {
    const prior = JSON.parse(readFileSync(join(outDir,'release-manifest.json'),'utf8'))
    for (const file of Object.keys(prior.generatedHashes)) {
      const absolute = resolve(outDir,file)
      if (!absolute.startsWith(resolve(outDir,'src') + sep)) throw new Error('Unsafe generated file path')
      unlinkSync(absolute)
    }
  }

  const write = (rel, text) => {
    const p = join(outDir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }

  /** For files the operator FILLS IN. Re-running the exporter must never
   *  clobber real secrets, so an existing file is left exactly as it is. */
  const writeIfAbsent = (rel, text) => {
    const p = join(outDir, rel)
    if (existsSync(p)) return false
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
    return true
  }

  for (const f of [...libFiles, ...strays]) {
    const rel = join('src', relative(SRC_ROOT, f)).split(sep).join('/')
    const text = readFileSync(f, 'utf8')
    // .json copies verbatim; .ts gets the same after() shim as the routes.
    write(rel, f.endsWith('.json') ? text : denextify(text, rel))
  }
  for (const g of generated) write(g.out, g.text)

  // Trade isolation: the per-service dialog wrapper the route now imports.
  write('src/lib/sms/service-dialog.ts', serviceDialogModule(trade))

  write('src/runtime/after.ts', tpl.after())
  write('src/runtime/readiness.ts', readFileSync(join(HERE, 'receptionist-runtime/readiness.ts.template'), 'utf8'))
  write('src/runtime/workers.ts', readFileSync(join(HERE, 'receptionist-runtime/workers.ts.template'), 'utf8'))
  write('src/runtime/scheduler.ts', readFileSync(join(HERE, 'receptionist-runtime/scheduler.ts.template'), 'utf8'))
  write('src/runtime/web-request.ts', tpl.webRequest())
  write('src/main.ts', tpl.main(trade, cfg))
  write('src/app.module.ts', tpl.appModule())
  write('src/receptionist/receptionist.module.ts', tpl.receptionistModule())
  write('src/receptionist/receptionist.controller.ts', tpl.receptionistController(trade))
  write('src/receptionist/dto/simulate-turn.dto.ts', tpl.simulateDto(trade))
  write('src/intake/intake.module.ts', tpl.intakeModule())
  write('src/intake/intake.controller.ts', tpl.intakeController())
  write('src/estimate/estimate.module.ts', tpl.estimateModule())
  write('src/estimate/estimate.controller.ts', tpl.estimateController())
  // Web surface — shared page/auth/sandbox code copied verbatim from
  // scripts/web-surface/ (edit THERE); only content.ts is per-trade.
  for (const f of WEB_FILES) {
    write(`src/web/${f}`, readFileSync(join(HERE, 'web-surface', f), 'utf8'))
  }
  write('src/web/content.ts', webContentTs(trade))
  // Scan AFTER the scaffolding above is on disk — main.ts and the
  // controllers read PORT, RAILWAY_PUBLIC_DOMAIN, SIM_API_KEY and friends,
  // which a scan of the copied lib alone would miss.
  const usedEnv = envVarsUsed(join(outDir, 'src'))
  write('src/config/required-env.ts', tpl.requiredEnv(REQUIRED_ENV.filter((v) => usedEnv.includes(v))))
  write('src/health/health.controller.ts', tpl.healthController(trade))

  const runtimeDeps = {
    '@nestjs/common': '^11.1.6',
    '@nestjs/config': '^4.0.2',
    '@nestjs/core': '^11.1.6',
    '@nestjs/platform-express': '^11.1.6',
    '@nestjs/swagger': '^11.2.0',
    'class-transformer': '^0.5.1',
    'class-validator': '^0.14.2',
    'reflect-metadata': '^0.2.2',
    rxjs: '^7.8.2',
  }
  for (const d of deps) {
    // Pin the EXACT version the monorepo resolved, not its semver range.
    // Stripe ships the pinned API version in its types, so a caret range
    // installs a newer client than lib/stripe/client.ts is written against
    // and the build fails on an apiVersion literal mismatch.
    const installed = join(SRC_ROOT, 'node_modules', d, 'package.json')
    if (existsSync(installed)) {
      runtimeDeps[d] = JSON.parse(readFileSync(installed, 'utf8')).version
      continue
    }
    const v = SRC_PKG.dependencies?.[d] ?? SRC_PKG.devDependencies?.[d]
    if (!v || !/^\d+\.\d+\.\d+(?:-|$)/.test(v)) throw new Error(`Dependency ${d} has no exact installed version; install platform dependencies before exporting`)
    runtimeDeps[d] = v
  }

  write('package.json', JSON.stringify({
    name: `qm-${trade}-receptionist`,
    version: '0.1.0',
    private: true,
    description: cfg.blurb,
    scripts: {
      build: 'node scripts/receptionist-build.mjs',
      start: 'node dist/main.js',
      'start:dev': 'nest start --watch',
      typecheck: 'tsc --noEmit',
      lint: 'eslint src --ext .ts',
    },
    dependencies: Object.fromEntries(Object.entries(runtimeDeps).sort(([a], [b]) => a.localeCompare(b))),
    devDependencies: {
      '@nestjs/cli': '^11.0.10',
      '@nestjs/schematics': '^11.0.9',
      '@types/express': '^5.0.3',
      '@types/node': '^20.19.9',
      'tsc-alias': '^1.8.16',
      typescript: '^5.9.2',
    },
    engines: { node: '>=20.11' },
  }, null, 2) + '\n')

  write('tsconfig.json', tpl.tsconfig())
  for (const file of ['receptionist-build.mjs', 'receptionist-release-fingerprint.mjs']) {
    write(`scripts/${file}`, readFileSync(join(HERE, file), 'utf8'))
  }
  write('nest-cli.json', tpl.nestCli())
  write('.gitignore', tpl.gitignore())
  write('Dockerfile', tpl.dockerfile(trade))
  write('.dockerignore', tpl.dockerignore())
  write('railway.json', tpl.railwayJson())
  write('.nvmrc', '22\n')
  // .env.example is committed and always regenerated. .env is gitignored and
  // written ONLY when absent — it's where real values go.
  const body = envBody(trade, cfg, usedEnv)
  write('.env.example', body)
  const envCreated = writeIfAbsent('.env', body)
  write('README.md', readme(trade, cfg, stats))
  write('ISOLATION.md', isolationDoc(trade, cfg, libFiles))

  // The manifest is independent of deployed environment and contains no secrets.
  const generatedHashes = {}
  const hashTree = (directory) => {
    for (const ent of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, ent.name)
      if (ent.isDirectory()) hashTree(path)
      else generatedHashes[relative(outDir, path).split(sep).join('/')] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  hashTree(join(outDir, 'src'))
  const buildInputHashes = Object.fromEntries([
    'package.json','tsconfig.json','nest-cli.json','Dockerfile','.dockerignore','railway.json','.nvmrc',
    'scripts/receptionist-build.mjs','scripts/receptionist-release-fingerprint.mjs',
    ...(existsSync(join(outDir,'package-lock.json')) ? ['package-lock.json'] : []),
  ].map((file) => [file,createHash('sha256').update(readFileSync(join(outDir,file))).digest('hex')]))
  const originCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SRC_ROOT, encoding: 'utf8' }).trim()
  const manifest = {
    contractVersion: 2, trade, originCommit,
    requiredMigrations: REQUIRED_RECEPTIONIST_MIGRATIONS,
    platformContractHashes: Object.fromEntries([
      ...collectPlatformContractFiles(collectClosure, SRC_ROOT),
      ...RECEPTIONIST_SCHEMA_FILES,'app/api/health/sms-contract/route.ts',
      ...libFiles.map((f) => relative(SRC_ROOT,f).split(sep).join('/')),
      ...generated.map((g) => relative(SRC_ROOT,g.path).split(sep).join('/')),
      ...readdirSync(join(HERE,'receptionist-runtime')).filter((file) => file.endsWith('.template'))
        .map((file) => `scripts/receptionist-runtime/${file}`),
      'scripts/export-receptionist.mjs','scripts/receptionist-platform-contract.mjs',
      'scripts/receptionist-release-fingerprint.mjs',
      'scripts/receptionist-schema-contract.mjs',
      'scripts/receptionist-build.mjs',
      'scripts/verify-receptionist-release.mjs','scripts/seal-receptionist-release.mjs','pnpm-lock.yaml',
    ].map((file) => [file,createHash('sha256').update(readFileSync(join(SRC_ROOT,file))).digest('hex')])),
    dependencies: runtimeDeps, generatedHashes, buildInputHashes,
    approvalRequired: true, capabilities: { conversation: true, durableJobs: true, quoteLookup: true, deliveryReceipts: true },
  }
  write('release-manifest.json', JSON.stringify({ ...manifest, sourceHash: receptionistSourceHash(manifest) }, null, 2) + '\n')

  stats.envVars = usedEnv.length
  stats.envCreated = envCreated
  return stats
}

// ── main ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const wanted = args.filter((a) => !a.startsWith('--'))
const list = wanted.length ? wanted : Object.keys(TRADES)

for (const trade of list) {
  if (!TRADES[trade]) { console.error(`unknown trade: ${trade}`); process.exitCode = 1; continue }
  try {
    const s = buildTrade(trade, { dry })
    console.log(`\n── ${trade} ${dry ? '(dry run)' : ''}`)
    console.log(`   lib files : ${s.libFiles}  (${s.libLoc.toLocaleString()} lines)`)
    console.log(`   npm deps  : ${s.deps.join(', ')}`)
    console.log(`   env vars  : ${s.envVars} in .env.example` + (dry ? '' : s.envCreated ? '  · .env created (blank)' : '  · .env left as-is'))
    if (s.strays.length) console.log(`   non-lib   : ${s.strays.map((f) => relative(SRC_ROOT, f)).join(', ')}`)
    if (s.stubbornNext.length) console.log(`   NEXT DEP  : not shimmable — ${s.stubbornNext.join(' | ')}`)
    if (s.missing.length) console.log(`   UNRESOLVED: ${s.missing.slice(0, 10).join(' | ')}${s.missing.length > 10 ? ` (+${s.missing.length - 10})` : ''}`)
  } catch (e) {
    console.error(`\n── ${trade} FAILED: ${e.message}`)
    process.exitCode = 1
  }
}
