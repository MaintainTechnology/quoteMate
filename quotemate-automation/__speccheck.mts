import { canonicalise, getSpecDefs } from './lib/estimate/spec-registry'
import { evaluateDraftSpecGuard } from './lib/estimate/spec-guard'
import { findHeadlineMaterialIndex } from './lib/estimate/catalogue'
import { safetyReviewReasons, shouldHoldForReview } from './lib/quote/review-policy'

const names = [
  'Tesla Wall Connector Gen 3',
  'Customer to supply - Tesla Wall Connector Gen 3 EV charger install on new dedicated circuit',
  '6mm2 TPS 3 core cable',
  'Install EV charger',
  'Customer to supply - Tesla Wall Connector EV charger install on new dedicated single-phase circuit (Install EV charger assembly)',
]
for (const n of names) console.log(JSON.stringify(n), '->', canonicalise('phase', n))
console.log('defs', JSON.stringify(getSpecDefs('electrical','ev_charger')))

const lines = [
  { description: 'Tesla Wall Connector Gen 3', quantity: 1, unit: 'each', unit_price_ex_gst: 800, source: 'material' },
  { description: 'Install EV charger assembly', quantity: 1, unit: 'job', unit_price_ex_gst: 300, source: 'assembly:install-ev' },
  { description: 'Labour', quantity: 2, unit: 'hr', unit_price_ex_gst: 100, source: 'labour' },
]
console.log('headline idx', findHeadlineMaterialIndex(lines as any))

const draft = { good: { label: 'Good', line_items: lines } }
const res = evaluateDraftSpecGuard({
  draft: draft as any,
  requested: { phase: 'single-phase', charger_model: 'Tesla Wall Connector', cable_run_metres: '8' },
  trade: 'electrical',
  category: 'ev_charger',
  productRows: [],
  mode: 'shadow',
})
console.log(JSON.stringify(res, null, 2))
const mismatches = res.filter(r => r.decision.verdict === 'mismatch')
const flags = mismatches.map(m => `[spec-guard] ${m.tier}: ${m.decision.reason}`)
console.log('flags', JSON.stringify(flags))
console.log('safety', JSON.stringify(safetyReviewReasons(flags)))
console.log('hold', JSON.stringify(shouldHoldForReview({ policy: 'auto_send', riskFlags: flags, totalIncGst: 1320 })))
