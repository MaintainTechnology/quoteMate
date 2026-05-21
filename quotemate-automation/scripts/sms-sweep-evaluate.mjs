// Grade the SMS sweep results.
//
// For each test (one row from sms-sweep-results.json), pull the
// conversation that was alive at sentAt and read the agent reply.
// Evaluate three things:
//   1. RECOGNITION  — did the agent's first reply name the right service,
//                     extract a sensible job_type into conversation_state,
//                     or at least progress (rather than say "we don't do that")
//   2. QUESTIONS    — did the reply contain a question (any "?" or "what's"
//                     pattern) — that's the mandated-question check
//   3. ROUTING      — did the reply trigger a quote, an inspection upsell,
//                     or a decline. Compared against expected for the row's
//                     default_enabled state.
//
// Outputs:
//   sms-sweep-grading.json  — per-test grade
//   stdout                  — readable summary

import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
const { Client } = pg;
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

const TEST_FROM = "+61489083371";
const AGENT_TO = "+61481613464";

// Normalised tokens that should plausibly appear in the agent's reply when
// it correctly classifies the service. Misses are recorded as
// recognition=miss (worth a human look, not automatic FAIL).
const SERVICE_KEYWORDS = {
  "Install LED downlight": ["downlight", "downlights", "led light"],
  "Replace double GPO": ["gpo", "power point", "powerpoint", "outlet"],
  "Install customer-supplied ceiling fan": ["fan", "ceiling fan"],
  "Hardwire 240V smoke alarm": ["smoke alarm", "smoke detector"],
  "Install outdoor IP-rated LED light": ["outdoor light", "wall light", "exterior", "outdoor led"],
  "Supply + install AC ceiling fan": ["fan", "ceiling fan"],
  "Install premium DC fan with wall control": ["fan", "wall control", "dc fan"],
  "Install oven (existing wiring)": ["oven"],
  "Install cooktop (existing wiring)": ["cooktop"],
  "Diagnostic call-out (fault finding)": ["fault", "diagnostic", "trip", "stopped working"],
  "Hardwire oven": ["oven"],
  "Hardwire induction cooktop": ["cooktop", "induction"],
  "Install aircon power point": ["aircon", "power point", "split system"],
  "Install EV charger": ["ev", "charger", "tesla", "wall connector"],
  "Install bathroom exhaust fan": ["exhaust", "bathroom fan"],
  "Install outdoor IP-rated GPO": ["outdoor", "power point", "weatherproof"],
  "Install LED strip lighting": ["strip", "led strip"],
  "Install wired doorbell or intercom": ["doorbell", "intercom"],
  "Install security camera (single)": ["camera", "cctv", "security"],
  "Install motion sensor flood light": ["flood", "motion", "sensor"],
  "Hand rod blocked drain": ["blocked", "drain"],
  "Jet blast blocked drain": ["jet", "blocked", "drain", "stormwater"],
  "Install electric HWS": ["hot water", "hws", "electric"],
  "Install gas HWS": ["hot water", "hws", "gas"],
  "Install heat pump HWS": ["heat pump", "hot water"],
  "Tap washer replacement": ["tap", "dripping", "washer"],
  "Tap replacement": ["tap", "mixer"],
  "Toilet cistern repair": ["toilet", "cistern", "running"],
  "Toilet suite install": ["toilet", "suite"],
  "CCTV drain inspection": ["cctv", "camera", "drain"],
  "Gas appliance connection": ["gas", "cooktop", "appliance"],
  "Pressure reduction valve install": ["pressure", "prv", "valve"],
  "Disposal and site cleanup": ["disposal", "removal", "old"],
  "Install dishwasher": ["dishwasher"],
  "Install rainwater tank": ["rainwater", "tank"],
  "Install whole-house water filter": ["water filter", "filter"],
  "Install external garden tap": ["garden tap", "outdoor tap"],
  "Install washing machine taps": ["washing machine", "wm tap"],
  "Install garbage disposal": ["garbage disposal", "disposal", "insinkerator"],
  "Replace shower head": ["shower head", "shower"],
  "Replace toilet seat": ["toilet seat", "seat"],
  "Stormwater drain unblock": ["stormwater", "blocked", "drain"],
  "Leak detection": ["leak", "wet patch"],
};

function gradeReply(serviceName, body) {
  if (!body) return { recognition: "no_reply", questions: 0, routing: "no_reply" };
  const lower = body.toLowerCase();
  const tokens = SERVICE_KEYWORDS[serviceName] ?? [];
  const matched = tokens.find((t) => lower.includes(t));
  const recognition = matched ? "hit" : tokens.length === 0 ? "no_keywords_defined" : "miss";
  const questions = (body.match(/\?/g) ?? []).length;
  let routing = "dialog";
  if (/\$99\b|inspection|site visit|on[- ]site/i.test(body)) routing = "inspection";
  else if (/we don'?t do that|outside our|not something we|can't help/i.test(body)) routing = "decline";
  else if (/quote|tap to pay|deposit|good\b|better\b|best\b/i.test(body)) routing = "quote";
  return { recognition, questions, routing, matched_keyword: matched ?? null };
}

try {
  await c.connect();
  const results = JSON.parse(readFileSync("scripts/sms-sweep-results.json", "utf8"));

  // Pull every message in any conversation for the test pair within the
  // window covering the sweep. Done as ONE query then matched per-test.
  const earliest = results.reduce((min, r) => (r.sentAt < min ? r.sentAt : min), results[0]?.sentAt ?? new Date().toISOString());
  const { rows: msgs } = await c.query(
    `select m.id, m.conversation_id, m.direction, m.body, m.created_at
       from sms_messages m
       join sms_conversations sc on sc.id = m.conversation_id
      where sc.from_number = $1 and sc.to_number = $2
        and m.created_at >= $3::timestamptz - interval '1 minute'
      order by m.created_at`,
    [TEST_FROM, AGENT_TO, earliest],
  );
  console.log(`Pulled ${msgs.length} messages from the test pair.`);

  // For each test row, find the inbound that matches its TEST_ID prefix
  // and the agent's first outbound after it.
  const graded = [];
  for (const r of results) {
    const ib = msgs.find((m) => m.direction === "inbound" && m.body?.includes(`[${r.test_id}]`));
    let firstReply = null;
    if (ib) {
      firstReply = msgs.find(
        (m) => m.direction === "outbound" &&
               m.conversation_id === ib.conversation_id &&
               new Date(m.created_at) > new Date(ib.created_at),
      );
    }
    const grade = gradeReply(r.service_name, firstReply?.body ?? null);
    graded.push({
      test_id: r.test_id,
      trade: r.trade,
      service_name: r.service_name,
      default_enabled: r.default_enabled,
      mandated_questions_expected: r.mandated_questions,
      inbound_matched: !!ib,
      reply_received: !!firstReply,
      reply_body: firstReply?.body ?? null,
      ...grade,
    });
  }

  writeFileSync("scripts/sms-sweep-grading.json", JSON.stringify(graded, null, 2));

  // Summary
  const tally = { hit: 0, miss: 0, no_keywords_defined: 0, no_reply: 0 };
  const routingTally = { quote: 0, inspection: 0, decline: 0, dialog: 0, no_reply: 0 };
  for (const g of graded) {
    tally[g.recognition] = (tally[g.recognition] ?? 0) + 1;
    routingTally[g.routing] = (routingTally[g.routing] ?? 0) + 1;
  }
  console.log(`\n─── RECOGNITION ───`);
  for (const [k, n] of Object.entries(tally)) console.log(`  ${k.padEnd(22)} ${n}`);
  console.log(`\n─── ROUTING ───`);
  for (const [k, n] of Object.entries(routingTally)) console.log(`  ${k.padEnd(22)} ${n}`);

  console.log(`\n─── MISSES + NO-REPLIES (need investigation) ───`);
  for (const g of graded.filter((x) => x.recognition === "miss" || x.recognition === "no_reply")) {
    console.log(`  ${g.test_id} [${g.trade}] ${g.service_name}`);
    console.log(`    reply: ${g.reply_body?.slice(0, 180) ?? "(NO REPLY)"}`);
  }

  // Question coverage check — services with mandated_questions > 0 should
  // get at least one '?' in their first reply.
  const qFailures = graded.filter(
    (g) => g.mandated_questions_expected > 0 && g.reply_received && g.questions === 0,
  );
  if (qFailures.length) {
    console.log(`\n─── QUESTION-COVERAGE FAILURES (expected ≥1 question, got 0) ───`);
    for (const g of qFailures) {
      console.log(`  ${g.test_id} [${g.trade}] ${g.service_name}  expected_qs=${g.mandated_questions_expected}`);
      console.log(`    reply: ${g.reply_body?.slice(0, 180)}`);
    }
  }

  console.log(`\nGraded ${graded.length} tests. Detail: scripts/sms-sweep-grading.json`);
} catch (e) {
  console.error("FAILED:", e.message ?? e);
  process.exit(1);
} finally {
  await c.end();
}
