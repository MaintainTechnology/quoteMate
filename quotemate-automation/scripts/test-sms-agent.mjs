// ═══════════════════════════════════════════════════════════════════════
// QuoteMate · SMS AI Agent end-to-end test driver
//
// Drives a multi-turn conversation against /api/sms/inbound, signing each
// request like Twilio so the webhook accepts it. After every turn it pulls
// the agent's reply + conversation state from Supabase and prints them, so
// you see exactly what the customer would have received and what the
// dialog agent decided (ask / finish / escalate_inspection).
//
// Usage:
//   node --env-file=.env.local scripts/test-sms-agent.mjs
//     → runs every scripted scenario against prod
//
//   node --env-file=.env.local scripts/test-sms-agent.mjs --scenario=downlights
//     → runs a single scenario (downlights | switchboard | offtopic | ambiguous | photos)
//
//   node --env-file=.env.local scripts/test-sms-agent.mjs --mode=chat
//     → interactive REPL — type a message, see the agent's reply, repeat.
//       /quit ends, /state prints conversation status, /reset starts fresh.
//
//   --target=local         hits http://localhost:3000 (default: prod)
//   --from=+61400000111    override the simulated customer number
//   --pause=ms             ms between turns in scripted mode (default 1500)
//
// Pre-requisites in .env.local:
//   TWILIO_AUTH_TOKEN, TWILIO_SMS_NUMBER  (signs requests, default "To")
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (read agent reply)
//
// SAFETY: signs with the real Twilio token. Only point at deployments
// you own — never at someone else's webhook.
// ═══════════════════════════════════════════════════════════════════════

import { createHmac } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

// ── args ────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, ...v] = a.replace(/^--/, '').split('=')
    return [k, v.join('=') || 'true']
  }),
)

const TARGET =
  args.target === 'local'
    ? 'http://localhost:3000'
    : 'https://quote-mate-rho.vercel.app'

const ENDPOINT = `${TARGET}/api/sms/inbound`
const FROM = args.from ?? `+61400${String(Date.now()).slice(-6)}` // unique per run
const TO = process.env.TWILIO_SMS_NUMBER ?? '+61481613464'
const PAUSE_MS = parseInt(args.pause ?? '1500', 10)

const TOKEN = process.env.TWILIO_AUTH_TOKEN
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? 'ACtest'
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!TOKEN) die('Missing TWILIO_AUTH_TOKEN — run with --env-file=.env.local')
if (!SUPA_URL || !SUPA_KEY)
  die('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')

// ── scripted scenarios ──────────────────────────────────────────────────
// Each scenario is just an array of customer messages, sent in order.
// The agent decides when to finish / escalate; the harness reports it.
//
// Scenarios are grouped:
//   • electrical_* — NSW/NECA pilot (v3 strategy)
//   • plumbing_*   — QLD/QBCC pilot (v5 strategy)
//
// Plumbing scenarios test the v5 multi-trade path end-to-end:
//   classification → trade='plumbing' on intake → plumbing pricing_book
//   row picked → plumbing-prompt.ts drives the quote.
const SCENARIOS = {
  // ════════════ ELECTRICAL (existing, NSW/NECA) ════════════
  downlights: {
    title: 'Electrical happy path · 6 downlights, single-storey, ceiling access fine',
    messages: [
      'hi need a quote for 6 downlights',
      'single storey, ceiling cavity is accessible',
      'standard 9w warm white is fine',
      'bondi 2026, this weekend if possible',
    ],
    expectedFinal: 'finish',
    expectedTrade: 'electrical',
  },
  switchboard: {
    title: 'Electrical inspection · switchboard upgrade (out of SMS scope)',
    messages: ['can you quote a switchboard upgrade for my house?'],
    expectedFinal: 'escalate_inspection',
    expectedTrade: 'electrical',
  },
  offtopic: {
    title: 'Electrical off-topic steer · should re-ask the next missing field',
    messages: [
      'hey what do you think of the rugby last night',
      'oh ok, i need 4 power points installed in my garage',
      'standard 10A double GPOs, mounted at standard height',
      'paddington 2021, brick garage, surface mount is fine',
    ],
    expectedFinal: 'finish',
    expectedTrade: 'electrical',
  },
  ambiguous: {
    title: 'Electrical ambiguous start · agent should ask for clarification',
    messages: [
      'electrician?',
      'i need some lights done',
      '5 downlights replaced in the kitchen',
      'plaster ceiling, single storey, warm white LEDs',
      'erskineville 2043, any time next week',
    ],
    expectedFinal: 'finish',
    expectedTrade: 'electrical',
  },
  photos: {
    title: 'Electrical customer offers photos mid-flow (text-only — MMS not simulated)',
    messages: [
      'hey need 2 ceiling fans installed',
      'i can send you photos of the rooms if helpful',
      'both bedrooms, existing light fittings already there',
      'redfern 2016, no special features, standard install',
    ],
    expectedFinal: 'finish',
    expectedTrade: 'electrical',
  },

  // ════════════ PLUMBING (v5, QLD/QBCC) ════════════════════
  // Note: dialog flow stays electrical-centric per strategy.md v5 deferral.
  // The agent may ask about ceiling_type or colour — customer answers are
  // designed to be plausible / steer the agent forward regardless.
  blocked_drain: {
    title: 'Plumbing happy path · blocked kitchen drain (hand-rod tier)',
    messages: [
      'hi, my kitchen sink is gurgling and water wont drain at all',
      'Coorparoo 4151, single storey home',
      'just the kitchen sink, slow for a few days then stopped',
      "I'm Jeff, can you come tomorrow morning",
    ],
    expectedFinal: 'finish',
    expectedTrade: 'plumbing',
  },
  hot_water: {
    title: 'Plumbing happy path · electric HWS dead, like-for-like replacement',
    messages: [
      'our hot water unit died this morning, need a quote to replace',
      'electric storage 250L on the back wall, Bardon 4065',
      'happy with electric again, same spot, asap please',
      "I'm Sarah, single storey, easy access",
    ],
    expectedFinal: 'finish',
    expectedTrade: 'plumbing',
  },
  tap_repair: {
    title: 'Plumbing happy path · dripping basin tap (washer replace)',
    messages: [
      'bathroom basin tap is dripping non-stop, can you fix it',
      'Spring Hill 4000, just the hot side',
      "I'm Mark, single storey unit, sometime this week is fine",
      'no other plumbing issues',
    ],
    expectedFinal: 'finish',
    expectedTrade: 'plumbing',
  },
  toilet_repair: {
    title: 'Plumbing happy path · running cistern (internals replace)',
    messages: [
      'the toilet in our ensuite wont stop running, water just keeps going',
      'Paddington 4064, only one toilet affected',
      "I'm Anna, any time next week",
      'single storey, no other issues',
    ],
    expectedFinal: 'finish',
    expectedTrade: 'plumbing',
  },
  gas_fitting: {
    title: 'Plumbing inspection · gas smell near cooktop (emergency, gas-licence required)',
    messages: [
      'i can smell gas near our cooktop in the kitchen, kind of worrying',
      'Toowong 4066, single storey',
      "I'm David, urgent please",
    ],
    expectedFinal: 'escalate_inspection',
    expectedTrade: 'plumbing',
  },
  bathroom_renovation: {
    title: 'Plumbing inspection · bathroom rough-in (multi-fixture, multi-visit)',
    messages: [
      'doing a full bathroom reno in about 6 weeks, need a plumbing quote for rough-in and fit-off',
      'New Farm 4005, gutting the whole bathroom back to studs',
      "I'm Priya, builder is starting demo on the 1st of June",
    ],
    expectedFinal: 'escalate_inspection',
    expectedTrade: 'plumbing',
  },
}

// ── twilio signature (matches lib/sms/twilio-validator.ts) ──────────────
function sign(url, params) {
  const sorted = Object.keys(params).sort()
  let data = url
  for (const k of sorted) data += k + params[k]
  return createHmac('sha1', TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64')
}

// ── post one inbound SMS ────────────────────────────────────────────────
async function postInbound(body, from) {
  const params = {
    From: from,
    To: TO,
    Body: body,
    MessageSid: `SMtest${Date.now()}${Math.floor(Math.random() * 1000)}`,
    AccountSid: ACCOUNT_SID,
  }
  const signature = sign(ENDPOINT, params)
  const t0 = Date.now()
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
    },
    body: new URLSearchParams(params).toString(),
  })
  return { status: res.status, ms: Date.now() - t0, body: await res.text() }
}

// ── pull state from supabase ────────────────────────────────────────────
async function supaGet(path) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
    },
  })
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`)
  return res.json()
}

async function fetchConversation(fromNumber) {
  const rows = await supaGet(
    `sms_conversations?from_number=eq.${encodeURIComponent(fromNumber)}` +
      `&order=created_at.desc&limit=1`,
  )
  return rows[0] ?? null
}

async function fetchLastOutbound(conversationId, sinceIso) {
  // Poll briefly — the webhook persists the outbound after dispatch returns,
  // so it may lag a few hundred ms behind the HTTP response.
  for (let i = 0; i < 10; i++) {
    const rows = await supaGet(
      `sms_messages?conversation_id=eq.${conversationId}` +
        `&direction=eq.outbound` +
        `&created_at=gt.${encodeURIComponent(sinceIso)}` +
        `&order=created_at.desc&limit=1`,
    )
    if (rows[0]) return rows[0]
    await sleep(300)
  }
  return null
}

// v5: fetch the intake row to surface trade + job_type for verification.
// The conversation row gets intake_id set once structureIntake completes.
// Polls for a few seconds because the structurer runs in after().
async function fetchIntakeForConversation(conversationId) {
  for (let i = 0; i < 20; i++) {
    const conv = await supaGet(
      `sms_conversations?id=eq.${conversationId}&select=intake_id,status`,
    )
    const intakeId = conv?.[0]?.intake_id
    if (intakeId) {
      const rows = await supaGet(
        `intakes?id=eq.${intakeId}&select=id,trade,job_type,confidence,inspection_required`,
      )
      if (rows?.[0]) return rows[0]
    }
    await sleep(500)
  }
  return null
}

// ── scripted runner ─────────────────────────────────────────────────────
async function runScenario(name, scenario, fromNumber) {
  hr()
  console.log(`▶ ${name.toUpperCase()}  —  ${scenario.title}`)
  console.log(`  customer: ${fromNumber}    target: ${TARGET}`)
  hr()

  let pass = true
  const startedAt = new Date().toISOString()

  for (let i = 0; i < scenario.messages.length; i++) {
    const msg = scenario.messages[i]
    const before = new Date().toISOString()

    console.log(`\n[turn ${i + 1}/${scenario.messages.length}]`)
    console.log(`  ← customer: "${msg}"`)

    const r = await postInbound(msg, fromNumber)
    if (r.status !== 200) {
      console.log(`  ✗ webhook returned HTTP ${r.status} in ${r.ms}ms — ${r.body}`)
      pass = false
      break
    }

    const convo = await fetchConversation(fromNumber)
    if (!convo) {
      console.log(`  ✗ no conversation row found for ${fromNumber}`)
      pass = false
      break
    }
    const reply = await fetchLastOutbound(convo.id, before)

    if (!reply) {
      console.log(`  ✗ webhook 200 but no outbound message persisted (dispatch failed?)`)
      pass = false
      break
    }

    console.log(`  → agent:    "${reply.body}"`)
    console.log(
      `  · status=${convo.status}  turns=${convo.turn_count}  ` +
        `assumptions=${(convo.assumptions_made ?? []).length}  ` +
        `webhook=${r.ms}ms`,
    )

    // If the agent already closed the conversation, stop sending.
    if (convo.status !== 'open') {
      console.log(`\n  ↳ conversation closed by agent (status=${convo.status})`)
      break
    }

    if (i < scenario.messages.length - 1) await sleep(PAUSE_MS)
  }

  const final = await fetchConversation(fromNumber)
  hr()
  if (!final) {
    console.log(`✗ FAIL — no final conversation row`)
    return false
  }
  const action =
    final.status === 'structuring'
      ? 'finish'
      : final.status === 'done'
      ? 'escalate_inspection'
      : 'ask'
  const expected = scenario.expectedFinal
  const dialogOk = action === expected
  console.log(
    `${dialogOk ? '✓ PASS' : '✗ FAIL'} (dialog)  expected=${expected}  got=${action}  ` +
      `final_status=${final.status}  turn_count=${final.turn_count}`,
  )
  if ((final.assumptions_made ?? []).length) {
    console.log(`  assumptions captured:`)
    for (const a of final.assumptions_made) console.log(`    · ${a}`)
  }
  console.log(`  conversation_id=${final.id}  started=${startedAt}`)

  // v5: confirm trade classification on the resulting intake row.
  // Skipped silently for scenarios that don't reach intake creation
  // (e.g. early escalations where the dialog closes pre-structuring).
  let tradeOk = true
  if (scenario.expectedTrade && (final.status === 'structuring' || final.status === 'done')) {
    const intake = await fetchIntakeForConversation(final.id)
    if (!intake) {
      console.log(`  ⓘ intake not yet structured — trade check skipped`)
    } else {
      tradeOk = intake.trade === scenario.expectedTrade
      console.log(
        `${tradeOk ? '✓ PASS' : '✗ FAIL'} (trade)   expected=${scenario.expectedTrade}  ` +
          `got=${intake.trade}  job_type=${intake.job_type}  ` +
          `confidence=${intake.confidence}  inspection=${intake.inspection_required}`,
      )
    }
  }

  return pass && dialogOk && tradeOk
}

// ── interactive REPL ────────────────────────────────────────────────────
async function runChat(fromNumber) {
  hr()
  console.log(`▶ INTERACTIVE  —  type messages as the customer`)
  console.log(`  customer: ${fromNumber}    target: ${TARGET}`)
  console.log(`  commands: /quit  /state  /reset`)
  hr()

  let from = fromNumber
  const rl = createInterface({ input, output })

  while (true) {
    const line = (await rl.question('\nyou ← ')).trim()
    if (!line) continue
    if (line === '/quit') break
    if (line === '/reset') {
      from = `+61400${String(Date.now()).slice(-6)}`
      console.log(`  · new customer number: ${from}`)
      continue
    }
    if (line === '/state') {
      const c = await fetchConversation(from)
      if (!c) console.log('  · no conversation yet')
      else
        console.log(
          `  · status=${c.status}  turns=${c.turn_count}  ` +
            `assumptions=${(c.assumptions_made ?? []).length}  id=${c.id}`,
        )
      continue
    }

    const before = new Date().toISOString()
    const r = await postInbound(line, from)
    if (r.status !== 200) {
      console.log(`  ✗ HTTP ${r.status} in ${r.ms}ms — ${r.body}`)
      continue
    }
    const c = await fetchConversation(from)
    const reply = c ? await fetchLastOutbound(c.id, before) : null
    if (!reply) {
      console.log(`  ✗ webhook 200 but no outbound persisted`)
      continue
    }
    console.log(`agent → ${reply.body}`)
    console.log(
      `         (status=${c.status}  turn=${c.turn_count}  ${r.ms}ms)`,
    )
    if (c.status !== 'open') {
      console.log(
        `\n  ↳ agent closed the conversation (status=${c.status}). ` +
          `Use /reset to start a new one.`,
      )
    }
  }

  rl.close()
}

// ── orchestration ───────────────────────────────────────────────────────
async function main() {
  if (args.mode === 'chat') {
    await runChat(FROM)
    return
  }

  const which = args.scenario
  const list = which ? [which] : Object.keys(SCENARIOS)
  const results = []

  for (const name of list) {
    const scenario = SCENARIOS[name]
    if (!scenario) {
      console.log(
        `unknown scenario "${name}" — available: ${Object.keys(SCENARIOS).join(', ')}`,
      )
      process.exit(1)
    }
    // Fresh customer number per scenario so they don't share conversation rows.
    const number = `+61400${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 9)}`.slice(0, 12)
    const ok = await runScenario(name, scenario, number)
    results.push({ name, ok })
    if (list.length > 1) await sleep(PAUSE_MS)
  }

  hr()
  console.log('SUMMARY')
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'}  ${r.name}`)
  hr()
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

// ── helpers ─────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
function hr() {
  console.log('─'.repeat(72))
}
function die(msg) {
  console.error(msg)
  process.exit(1)
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(1)
})
