// One-shot: print the actual customer SMS bodies (auto + inspection)
// using the production buildQuoteSms code path. No network.
const { buildQuoteSms } = await import("../lib/sms/templates.ts");

const intake = {
  job_type: "downlights",
  caller: { name: "Sarah Johnson" },
  scope: { item_count: 6, description: "6 LED downlights replacing existing in living + kitchen" },
};

const autoQuote = {
  good: {
    label: "Standard 9W LED downlights",
    subtotal_ex_gst: 540,                                  // 540 * 1.10 = 594 inc GST
    line_items: [
      { unit: "each", quantity: 6,   description: "9W LED downlight",  total_ex_gst: 264, unit_price_ex_gst: 44 },
      { unit: "hr",   quantity: 2.5, description: "Labour",            total_ex_gst: 275, unit_price_ex_gst: 110 },
    ],
  },
  better: {
    label: "Dimmable 10W LED downlights, 5yr warranty",
    subtotal_ex_gst: 800,                                  // 800 * 1.10 = 880 inc GST
    line_items: [
      { unit: "each", quantity: 6,   description: "Dimmable 10W LED",  total_ex_gst: 414, unit_price_ex_gst: 69 },
      { unit: "hr",   quantity: 3.5, description: "Labour",            total_ex_gst: 385, unit_price_ex_gst: 110 },
    ],
  },
  best: {
    label: "Premium tunable-white LED, app-controlled",
    subtotal_ex_gst: 1100,                                 // 1100 * 1.10 = 1210 inc GST
    line_items: [
      { unit: "each", quantity: 6,   description: "Tunable-white LED", total_ex_gst: 605, unit_price_ex_gst: 100.83 },
      { unit: "hr",   quantity: 4.5, description: "Labour",            total_ex_gst: 495, unit_price_ex_gst: 110 },
    ],
  },
  selected_tier: "better",
  scope_of_works: "Replace 6 existing downlights in living/kitchen ceilings with new LEDs, including disposal of old fittings and circuit testing. All fittings IC-F rated, terminated to existing circuits, tested with calibrated equipment, certificate of compliance issued.",
  scope_short: "6 LED downlights in living + kitchen",
  assumptions: ["flat plaster ceiling", "existing wiring", "indoor only"],
  estimated_timeframe: "1-2 days",
  needs_inspection: false,
  inspection_reason: null,
  quote_view_url: "https://quote-mate-rho.vercel.app/q/qt_a8f3b2c1",
  pay_links: {
    good:   "https://quote-mate-rho.vercel.app/r/qt_a8f3b2c1/good",
    better: "https://quote-mate-rho.vercel.app/r/qt_a8f3b2c1/better",
    best:   "https://quote-mate-rho.vercel.app/r/qt_a8f3b2c1/best",
  },
  deposit_pct: 30,
};

const inspectionQuote = {
  good: null, better: null, best: null,
  selected_tier: "inspection",
  scope_of_works: "Switchboard upgrade with EV charger circuit.",
  scope_short: "Switchboard upgrade + EV charger",
  assumptions: [],
  estimated_timeframe: null,
  needs_inspection: true,
  inspection_reason: "switchboard work and new EV circuit need on-site assessment",
  quote_view_url: "https://quote-mate-rho.vercel.app/q/xyz789",
  pay_links: { inspection: "https://quote-mate-rho.vercel.app/r/xyz789/inspection" },
  deposit_pct: null,
};

const auto = buildQuoteSms(intake, autoQuote);
const insp = buildQuoteSms(intake, inspectionQuote);

console.log("══════════════════ AUTO-QUOTE (3 tiers) ══════════════════");
console.log(auto);
console.log(`\n[${auto.length} chars · ${Math.ceil(auto.length / 153)} SMS segments]`);

console.log("\n\n═══════════════ INSPECTION-REQUIRED ($99) ═══════════════");
console.log(insp);
console.log(`\n[${insp.length} chars · ${Math.ceil(insp.length / 153)} SMS segments]`);
