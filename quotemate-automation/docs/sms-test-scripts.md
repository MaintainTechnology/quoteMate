# SMS Agent — Test Scripts

Texts you can send to the dev number **+61 481 613 464** to exercise the agent end-to-end. Each script lists what YOU send and roughly what the agent should reply (the wording will vary turn-to-turn — Haiku 4.5 is the brain — but the *shape* of the reply should match).

The agent's rule book lives in [`lib/sms/dialog.ts`](../lib/sms/dialog.ts) and the per-job questions in [`lib/sms/assumptions.ts`](../lib/sms/assumptions.ts). If a real reply doesn't match what's below, the bug is almost always in one of those two files.

> **Reset between scripts:** if you've texted recently, the agent will treat you as `continuing` (no greeting) or `returning` (welcome back). To get a clean `first_time` run, wait >5 min after a `done` conversation, or wipe the row in `sms_conversations` for your number.

---

## 1. Happy path — downlights (the canonical 6-turn flow)

**Turn 1**
YOU: `6 downlights`
AGENT: `G'day, thanks for messaging QuoteMate — I'm the AI quoting assistant. Quick few details and I'll get a quote across. First — what's your first name?`

**Turn 2**
YOU: `Sam`
AGENT: `Cheers Sam — and what suburb is the job in?`

**Turn 3**
YOU: `Bondi`
AGENT: `Right you are. Which room — and how's the ceiling, flat plaster or raked?` *(may split across turns)*

**Turn 4**
YOU: `Lounge, flat plaster`
AGENT: `Got it. Are these replacing existing downlights, or a new install?`

**Turn 5**
YOU: `Replacing`
AGENT: `Easy. Any colour preference — warm white, cool white, tri-colour, or no preference?`

**Turn 6**
YOU: `Warm white`
AGENT: `Beauty Sam — I'll flick you a photo link in a sec for 1-2 ceiling pics. Just to confirm: 6 warm-white LED downlights in the Bondi lounge, replacing existing, flat plaster ceiling. Sound right?`
*(separate SMS arrives with `https://quote-mate-rho.vercel.app/upload/...`)*

**Turn 7**
YOU: `Yep`
AGENT: `All good Sam — quote on its way shortly.`
*(quote SMS lands ~70s later with good/better/best tiers + pay links)*

**What to verify:**
- Turn 1 includes the FULL intro (`thanks for messaging QuoteMate — I'm the AI quoting assistant`).
- Photo-link SMS fires on turn 6, NOT earlier (this was a recent bug fix — Rule 10).
- Verification handshake (`Sound right?`) happens BEFORE `action='finish'`.
- Final quote SMS is plain ASCII (GSM-7), single-segment-friendly, with `Tap to pay:` links.

---

## 2. Happy path — power points (shorter MUST-ASK list)

**Turn 1**
YOU: `Need 3 GPOs replaced`
AGENT: Full intro + asks for first name.

**Turn 2**
YOU: `Jenna`
AGENT: `Cheers Jenna — and what suburb?`

**Turn 3**
YOU: `Newtown`
AGENT: `Got it. Which room are the GPOs in?`

**Turn 4**
YOU: `Living room`
AGENT: `Sweet — just to confirm: 3 GPO replacements in your Newtown living room. Sound right?`
*(photo link fires on this turn)*

**Turn 5**
YOU: `Yes`
AGENT: `All good Jenna — quote on its way shortly.`

---

## 3. Happy path — ceiling fans (supply-or-customer-supply twist)

**Turn 1**
YOU: `2 ceiling fans`
AGENT: Full intro + first name.

**Turn 2**
YOU: `Marcus`
AGENT: `Cheers Marcus — what suburb?`

**Turn 3**
YOU: `Coogee`
AGENT: `Got it. Which rooms?`

**Turn 4**
YOU: `Both bedrooms`
AGENT: `Right — do you already have the fans, or want us to supply them?`

**Turn 5**
YOU: `I've got them`
AGENT: `Sweet — just to confirm: 2 ceiling fan installs in your Coogee bedrooms, fans supplied by you, existing wiring. Sound right?`

**Turn 6**
YOU: `Yep`
AGENT: `Beauty — quote drafting now, you'll see it in 2 mins.`

---

## 4. Happy path — smoke alarms (compliance flavour)

**Turn 1**
YOU: `Need to replace my smoke alarms`
AGENT: Full intro + first name.

**Turn 2**
YOU: `Priya`
AGENT: `Cheers Priya — what suburb?`

**Turn 3**
YOU: `Parramatta`
AGENT: `Got it. How many alarms, and is this a like-for-like replacement?`

**Turn 4**
YOU: `4, replacing`
AGENT: `Sweet — just to confirm: 4 smoke alarm replacements in Parramatta. Sound right?`

**Turn 5**
YOU: `Correct`
AGENT: `All good Priya — quote on its way shortly.`

---

## 5. Happy path — outdoor lighting

**Turn 1**
YOU: `Hi, I want some lights on my deck`
AGENT: Full intro + first name.

**Turn 2**
YOU: `Tom`
AGENT: `Cheers Tom — what suburb?`

**Turn 3**
YOU: `Manly`
AGENT: `Got it. How many fittings, and where on the deck — eaves, posts, or somewhere else?`

**Turn 4**
YOU: `4 fittings, under the eaves`
AGENT: `Right — sensor activated or always-on?`

**Turn 5**
YOU: `Sensor`
AGENT: `Sweet — just to confirm: 4 sensor-activated outdoor downlights under the Manly deck eaves. Sound right?`

**Turn 6**
YOU: `Yes`
AGENT: `Beauty Tom — quote drafting now.`

---

## 6. Inspection escalation — switchboard (universal trigger)

**Turn 1**
YOU: `My switchboard keeps tripping`
AGENT: `G'day, thanks for messaging QuoteMate — I'm the AI quoting assistant. For that I'll need to send a sparky for a quick look. Want me to text you a $99 inspection booking?`

**Turn 2**
YOU: `Yes please`
AGENT: `All good — booking link incoming.`
*(then a separate inspection-flavoured SMS lands with the $99 site-visit pay link)*

**What to verify:**
- Agent does NOT try to gather count/room/etc — switchboard is in `UNIVERSAL_INSPECTION_TRIGGERS`.
- Conversation status flips to `done` immediately after escalation (no intake handoff).

---

## 7. Inspection escalation — EV charger (out-of-easy-5)

**Turn 1**
YOU: `Need an EV charger installed for my Tesla`
AGENT: Full intro + escalation: `For an EV charger I'll need to send a sparky for a quick look. Want me to text you a $99 inspection booking?`

---

## 8. Inspection escalation — safety words

Try ONE of these as the first message; agent should escalate immediately, no questions asked:

- `I can smell burning from a power point`
- `Sparks came out of the light switch`
- `Got an electric shock from the wall`
- `Breaker keeps tripping`

Expected reply shape: `For that I'll need to send a sparky for a quick look. Want me to text you a $99 inspection booking?`

---

## 9. Off-topic redirect

**Turn 1**
YOU: `What's the weather like in Sydney today`
AGENT: Full intro followed by a polite redirect: `G'day — happy to quote any electrical work. What were you after?`

**Turn 2**
YOU: `Do you guys do plumbing too`
AGENT: `Cheers — we're sparkies, not plumbers. Any electrical work you needed quoted?`

**Turn 3**
YOU: `Tell me a joke`
AGENT: `Ha — back to it though, what electrical work did you need?`

**What to verify:** agent stays focused, no banter, never breaks character with "I'm just an AI assistant" type lines.

---

## 10. Vague opener (no job stated)

**Turn 1**
YOU: `Hi`
AGENT: `G'day, thanks for messaging QuoteMate — I'm the AI quoting assistant. What electrical work did you need? (downlights, GPOs, ceiling fans, smoke alarms, outdoor lighting)`

**Turn 2**
YOU: `Just need a quote`
AGENT: `No worries — what work did you need? (downlights, GPOs, ceiling fans, smoke alarms, outdoor lighting)`

---

## 11. Correction during verification handshake

Run script #1 up to turn 6, but instead of `Yep`, send a correction:

**Turn 6 (your reply)**
YOU: `Actually make it 5 not 6, and cool white`
AGENT: `No dramas — just to confirm: 5 cool-white LED downlights in the Bondi lounge, replacing existing, flat plaster ceiling. Sound right?`

**Turn 7**
YOU: `Yes`
AGENT: `All good Sam — quote on its way shortly.`

**What to verify:** agent re-issues the `Sound right?` summary with corrected fields, doesn't auto-finish on the corrective message.

---

## 12. Returning customer (welcome-back opener)

Pre-condition: complete script #1 successfully so your number has a `done` conversation. Wait >5 min, then text again.

**Turn 1**
YOU: `Hi need another quote`
AGENT: `Welcome back — what can I help you with this time?`
*(NOT the full first-time intro)*

---

## 13. Continuing customer (mid-flow ping)

Pre-condition: be mid-conversation (e.g. paused after turn 3 of script #1). Send a check-in.

**Turn 4**
YOU: `You still there?`
AGENT: `Still here — was that 6 downlights in Bondi? What suburb?`
*(no greeting, references prior turns)*

---

## 14. In-flight short-circuit (the canned hold-on)

Pre-condition: complete script #1 to `Yep` on turn 7. Within 60s of the agent saying "quote on its way", text a NEW message before the quote SMS lands.

**Turn 8**
YOU: `Actually I also need a ceiling fan`
AGENT: `Cheers - just finalising the quote we were working on (under a minute). Once it lands, hit me back with this one and I'll get straight onto it.`

**What to verify:**
- This canned message bypasses Haiku entirely (look for `INFLIGHT — sending canned hold-on, skipping Haiku` in logs).
- Your second message is preserved in `sms_messages` but NOT processed as a new dialog turn.
- After the quote arrives, you can re-text and it picks up normally (5-min done-grace REUSE).

---

## 15. Too-many-turns escalation

Send 4 inbound messages that don't progress the intake. Example:

**Turn 1**
YOU: `Hi`
AGENT: Full intro asking what work.

**Turn 2**
YOU: `Maybe lights or something`
AGENT: `No worries — what specifically? Downlights, ceiling fans, outdoor lighting?`

**Turn 3**
YOU: `Not sure yet`
AGENT: Asks for clarification.

**Turn 4**
YOU: `What do you recommend`
AGENT: Should escalate: `For that I'll need to send a sparky for a quick look — easier to get specifics in person. Want me to text a $99 inspection booking?`

**What to verify:** Rule 7 fires after 4 inbound turns with insufficient info → `escalate_inspection`.

---

## 16. MMS / photo upload

Use script #1 but on turn 4 (after they ask about ceiling type), attach a photo of a ceiling instead of text. The agent should:

- Persist the inbound row with `photo_urls` populated (check `sms_messages` table).
- Treat the message as if you'd answered the open question textually OR gracefully ask the same question again if the photo doesn't substitute.

---

## Quick smoke test (one-liner)

Just want to confirm the webhook + dispatcher are alive? Text `Hi` from any number — within ~3-5 seconds you should get the full first-time intro back. If you don't, check Vercel function logs for `[sms/inbound]` traces.

---

## Notes on what each test exercises

- **Scripts 1–5** — `decideNextTurn` happy paths, photo-link timing (Rule 10), verification handshake (Rule 11), intake handoff to `/api/intake/structure`.
- **Scripts 6–8** — `UNIVERSAL_INSPECTION_TRIGGERS` matching + per-job `inspectionTriggers`.
- **Script 9** — Rule 8 (off-topic redirect, no engagement).
- **Script 10** — Rule 9 Case A first-time intro.
- **Script 11** — Rule 11 handshake correction branch (8c).
- **Script 12** — Rule 9 Case B (`returning` history hint).
- **Script 13** — Rule 9 Case C (`continuing` history hint, no greeting).
- **Script 14** — INFLIGHT short-circuit in `app/api/sms/inbound/route.ts` — canned `buildQuoteInFlightSms`.
- **Script 15** — Rule 7 turn-count escalation.
- **Script 16** — `extractAndStoreMmsPhotos` in `lib/sms/mms.ts`.
