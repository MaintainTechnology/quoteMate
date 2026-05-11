// ═══════════════════════════════════════════════════════════════════
// AI preview prompts — flexible, customer-driven systemInstruction.
//
// The systemInstruction for every Gemini call is built from data
// captured across the SMS conversation + intake structuring + quote
// estimation. The TEMPLATE is hardcoded scaffolding; every VALUE
// (count, job type, customer name, products, etc.) is interpolated
// at runtime from the database rows, so the same template handles
// downlights / ceiling fans / GPOs / smoke alarms / outdoor lighting
// (and any future job type) with zero per-job branching.
//
// Inputs (assembled by generate.ts and samples.ts):
//   · intake       — the IntakeSchema row (customer's verbatim words,
//                    structured slots, caller, access, property, etc.)
//   · quote        — the estimator's draft (scope_of_works,
//                    assumptions, selected_tier, needs_inspection)
//   · lineItems    — quote_line_items filtered to the selected tier
//                    (gives us the SPECIFIC product names)
//   · corrections  — slot names the customer corrected mid-SMS
//                    (high-signal preferences they cared enough to fix)
//
// Output: { system, user } pair. systemInstruction holds the brief;
// user message is minimal ("Generate the image now…") plus the
// reference photo when present.
// ═══════════════════════════════════════════════════════════════════

// ─── Input types ───

export type PromptIntake = {
  job_type: string
  scope?: {
    item_count?: number | null
    is_new_install?: boolean | null
    existing_wiring?: boolean | null
    indoor_outdoor?: 'indoor' | 'outdoor' | 'both' | 'unknown' | null
    description?: string | null
    specs?: {
      color_temp?: 'warm_white' | 'cool_white' | 'tri_colour' | 'unknown' | null
      dimmable?: boolean | null
      smart?: boolean | null
      weatherproof?: boolean | null
      supplied_by?: 'tradie' | 'customer' | null
    } | null
  } | null
  access?: {
    roof_access?: boolean | null
    ceiling_type?: 'flat' | 'raked' | 'high' | 'unknown' | null
    wall_type?: 'plaster' | 'brick' | 'concrete' | 'tile' | 'unknown' | null
  } | null
  property?: {
    bedrooms?: number | null
    levels?: number | null
  } | null
  caller?: { name?: string | null } | null
  timing?: {
    urgency?: 'emergency' | 'this_week' | 'this_month' | 'flexible' | null
  } | null
}

export type PromptQuote = {
  selected_tier?: 'good' | 'better' | 'best' | null
  scope_of_works?: string | null
  assumptions?: string[] | null
  needs_inspection?: boolean | null
}

export type PromptLineItem = {
  tier: string
  description: string
  quantity?: number | null
  source?: string | null // 'material' | 'labour' | 'call_out'
}

export type PromptCorrection = {
  slot: string          // e.g. 'count', 'suburb', 'colour'
  finalValue: string    // the value after the correction
}

export type PromptContext = {
  intake: PromptIntake
  quote?: PromptQuote | null
  lineItems?: PromptLineItem[] | null
  corrections?: PromptCorrection[] | null
}

export type SystemUserPrompt = {
  system: string
  user: string
}

// ─── Helpers ───

function humaniseJobType(jobType: string): { plural: string; singular: string } {
  const plural = (jobType ?? '').replace(/_/g, ' ').trim() || 'fittings'
  const singular = /ss$/i.test(plural) ? plural : plural.replace(/s$/i, '')
  return { plural, singular }
}

function colorTempHuman(temp?: string | null): string | null {
  if (!temp || temp === 'unknown') return null
  if (/warm/i.test(temp)) return 'warm white (≈2700K–3000K)'
  if (/cool/i.test(temp)) return 'cool white (≈4000K–5000K)'
  if (/tri/i.test(temp)) return 'tri-colour selectable'
  if (/daylight|natural/i.test(temp)) return 'daylight (≈5000K–6500K)'
  return temp
}

function detectRoom(desc?: string | null): string | null {
  if (!desc) return null
  const m = desc.match(/\b(lounge|living\s*room|kitchen|bedroom|bathroom|dining|study|hallway|garage|deck|patio|courtyard|backyard|laundry|alfresco|ensuite)\b/i)
  return m ? m[1].toLowerCase().replace(/\s+/g, ' ') : null
}

function prefLine(label: string, value: string | number | boolean | null | undefined): string | null {
  if (value === null || value === undefined || value === '' || value === 'unknown') return null
  if (typeof value === 'boolean') return `  · ${label}: ${value ? 'yes' : 'no'}`
  return `  · ${label}: ${value}`
}

function humaniseSlot(slot: string): string {
  return slot.replace(/_/g, ' ')
}

// Pick the single "anchor product" — the headline item the tradie
// quoted for. Used to enforce visual consistency across all 4 Gemini
// calls (Preview, Wide, Close-up, In-use). Without an anchor, each
// call interprets the spec independently and the 3 sample images
// drift apart (e.g. wide shows wall-faced toilet, close-up shows
// close-coupled).
//
// Selection:
//   1. Filter to material line items in the selected tier
//   2. Exclude sundries (terminals, fittings, tape, seals, etc.)
//   3. Prefer the line whose quantity matches the customer's count
//      (typically the headline product — e.g. "8 × Dimmable IP-rated
//      downlight" when customer asked for 8)
//   4. Otherwise pick the first remaining material
//   5. Return null if no anchor can be derived; the prompt then falls
//      back to the generic job-type label.
function pickAnchorProduct(ctx: PromptContext): string | null {
  if (!ctx.lineItems || ctx.lineItems.length === 0) return null
  const tier = ctx.quote?.selected_tier ?? 'better'
  const count = ctx.intake.scope?.item_count ?? null
  const materials = ctx.lineItems.filter(li =>
    li.tier === tier &&
    (li.source === 'material' || !li.source) &&
    !/\b(sundr|fittings,|seal|tape|clip|terminal)\b/i.test(li.description)
  )
  if (materials.length === 0) return null
  const matchByCount = count !== null
    ? materials.find(m => m.quantity === count)
    : null
  const pick = matchByCount ?? materials[0]
  return pick.description
}

// ─── The customer-prefs block ───
function buildCustomerPrefsBlock(ctx: PromptContext): string {
  const { intake, quote, lineItems, corrections } = ctx
  const desc = (intake.scope?.description ?? '').trim()
  const callerName = intake.caller?.name?.trim() || null
  const callerLabel = callerName ?? 'the customer'
  const room = detectRoom(desc)
  const { plural: jobLabelPlural, singular: jobLabelSingular } = humaniseJobType(intake.job_type)

  const count = (intake.scope?.item_count && intake.scope.item_count > 0)
    ? intake.scope.item_count
    : null

  const specs = intake.scope?.specs ?? {}
  const access = intake.access ?? {}
  const property = intake.property ?? {}

  const prefLines = [
    prefLine('Job', jobLabelPlural),
    prefLine('Quantity', count),
    prefLine('Room', room),
    prefLine('Indoor or outdoor', intake.scope?.indoor_outdoor),
    prefLine('New install or replacing existing',
      intake.scope?.is_new_install === true ? 'new install'
      : intake.scope?.is_new_install === false ? 'replacing existing'
      : null),
    prefLine('Existing wiring already in place', intake.scope?.existing_wiring),
    prefLine('Colour temperature', colorTempHuman(specs.color_temp)),
    prefLine('Dimmable', specs.dimmable),
    prefLine('Smart / Wi-Fi / app-controlled', specs.smart),
    prefLine('Weatherproof / IP-rated', specs.weatherproof),
    prefLine('Fitting supplied by', specs.supplied_by),
    prefLine('Ceiling type', access.ceiling_type),
    prefLine('Wall type', access.wall_type),
    prefLine('Property bedrooms', property.bedrooms),
    prefLine('Property levels', property.levels),
    prefLine('Customer urgency', intake.timing?.urgency),
  ].filter((l): l is string => l !== null)

  const lines: string[] = []

  // ── Role / framing ──
  const tierLabel = quote?.selected_tier
    ? `, then accepted the tradie's "${quote.selected_tier}"-tier quote`
    : ''
  // v5 multi-trade: derive trade-flavour from intake so the Gemini scene
  // framing matches the right trade (electrical fitting render vs plumbing
  // fixture render). Falls back to "trade" if intake.trade is unset.
  const tradeFlavour =
    (intake as { trade?: string }).trade === 'plumbing' ? 'plumbing'
    : (intake as { trade?: string }).trade === 'electrical' ? 'electrical'
    : 'trade'
  lines.push(`You are rendering an image for ${callerLabel}, a real Australian customer who requested ${tradeFlavour} work via an SMS conversation with the QuoteMate team${tierLabel}. ${callerName ?? 'They'} confirmed every preference below on SMS — your job is to render exactly what ${callerName ?? 'the customer'} asked for, nothing more.`)
  lines.push(``)

  // ── Verbatim customer words ──
  lines.push(`WHAT ${callerName ? callerName.toUpperCase() : 'THE CUSTOMER'} SAID (verbatim from the SMS conversation):`)
  if (desc) {
    lines.push(`  "${desc.slice(0, 600)}"`)
  } else {
    lines.push(`  (no free-text description — see confirmed preferences below)`)
  }
  lines.push(``)

  // ── ANCHOR PRODUCT — visual consistency across all 4 images ──
  const anchor = pickAnchorProduct(ctx)
  if (anchor) {
    lines.push(`════════════════════════════════════════════════════════════════`)
    lines.push(`ANCHOR PRODUCT — render THIS exact product in this image:`)
    lines.push(``)
    lines.push(`   ▶ ${anchor}`)
    lines.push(``)
    lines.push(`This is the SPECIFIC product ${callerName ?? 'the customer'} is being quoted for.`)
    lines.push(`Every image in this 4-image quote set (Preview + Wide sample +`)
    lines.push(`Close-up sample + In-use sample) MUST depict the SAME product —`)
    lines.push(`the one named above. Do not substitute. Do not swap to a generic`)
    lines.push(`alternative. Do not show a different style or model. If the`)
    lines.push(`anchor is "Wall-faced toilet suite (Caroma Liano)", do NOT render`)
    lines.push(`a close-coupled toilet. If the anchor is "Dimmable IP-rated`)
    lines.push(`downlight", do NOT render a plain basic downlight. Match the`)
    lines.push(`exact product name, brand, and style described above.`)
    lines.push(`════════════════════════════════════════════════════════════════`)
    lines.push(``)
  }

  // ── Structured preferences ──
  if (prefLines.length > 0) {
    const possessive = callerName ? `${callerName.toUpperCase()}'S` : `THE CUSTOMER'S`
    lines.push(`${possessive} CONFIRMED PREFERENCES (each one was verified back to ${callerName ?? 'the customer'} via the SMS handshake and they replied "yes, that's right"):`)
    for (const p of prefLines) lines.push(p)
    lines.push(``)
    lines.push(`Any preference NOT listed above was not specified by ${callerName ?? 'the customer'} during the SMS conversation. For those, use neutral defaults — do not invent or imply features ${callerName ?? 'they'} did not ask for.`)
    lines.push(``)
  }

  // ── Customer corrections (high-signal) ──
  if (corrections && corrections.length > 0) {
    lines.push(`PREFERENCES ${callerName ?? 'THE CUSTOMER'} CORRECTED MID-CONVERSATION (they cared enough to fix these — render them precisely):`)
    for (const c of corrections) {
      lines.push(`  · ${humaniseSlot(c.slot)}: customer corrected to "${c.finalValue}"`)
    }
    lines.push(``)
  }

  // ── Quote / estimator context ──
  if (quote && !quote.needs_inspection) {
    const tierPlain = (quote.selected_tier ?? 'better').toUpperCase()
    lines.push(`QUOTE BUILT BY THE ESTIMATOR — selected tier: ${tierPlain}`)
    if (quote.scope_of_works) {
      lines.push(`Scope of works (the estimator's plain-English description of the job):`)
      lines.push(`  "${quote.scope_of_works.slice(0, 500)}"`)
    }
    const materialItems = (lineItems ?? []).filter(li =>
      li.tier === (quote.selected_tier ?? 'better') &&
      (li.source === 'material' || !li.source)
    )
    if (materialItems.length > 0) {
      lines.push(`Specific products to render (from the ${tierPlain} tier line items):`)
      for (const li of materialItems) {
        const qty = li.quantity && li.quantity > 1 ? `${li.quantity} × ` : ''
        lines.push(`  · ${qty}${li.description}`)
      }
    }
    if (quote.assumptions && quote.assumptions.length > 0) {
      lines.push(`Estimator's assumptions (may have visual relevance):`)
      for (const a of quote.assumptions.slice(0, 6)) {
        lines.push(`  · ${a}`)
      }
    }
    lines.push(``)
  }

  // ── Count anchor ──
  if (count !== null) {
    lines.push(`COUNT — ${callerName ?? 'the customer'} asked for exactly ${count} ${count === 1 ? jobLabelSingular : jobLabelPlural}. Render exactly ${count} — no more, no fewer.`)
  }

  return lines.join('\n')
}

// ─── Universal constraints ───
function universalConstraints(): string {
  return [
    `UNIVERSAL CONSTRAINTS (apply to every image):`,
    `  · No people, pets, hands, text overlays, captions, annotations, or logos in the image — only the small AI-watermark specified in the per-shot context.`,
    `  · Photorealistic, magazine-quality interior photography style. Modern Australian residential aesthetic.`,
  ].join('\n')
}

// ─── Per-shot system-instruction builder ───
function buildSystemInstruction(ctx: PromptContext, shotContext: string): string {
  return [
    buildCustomerPrefsBlock(ctx),
    ``,
    universalConstraints(),
    ``,
    `THIS IMAGE:`,
    shotContext,
  ].join('\n')
}

// ════════════════════════════════════════════════════════════════════
// PREVIEW prompt
// ════════════════════════════════════════════════════════════════════

export function buildPreviewPrompt(ctx: PromptContext): SystemUserPrompt {
  const room = detectRoom(ctx.intake.scope?.description) ?? 'space'
  const { plural: jobLabelPlural } = humaniseJobType(ctx.intake.job_type)
  const callerName = ctx.intake.caller?.name?.trim() || null
  const callerLabel = callerName ?? 'the customer'
  const callerPossessive = callerName ? `${callerName}'s` : `the customer's`
  const isReplacement = ctx.intake.scope?.is_new_install === false
  const anchor = pickAnchorProduct(ctx)

  const shotContext = [
    `  An EDIT of ${callerPossessive} OWN PHOTO of their ${room}. The user message includes ${callerLabel}'s actual photo — edit it to show their requested install. Keep the walls, floor, furniture, decor, perspective, and camera angle exactly as in the photo; only the relevant fixture area changes. If ${callerPossessive} photo already contains existing ${jobLabelPlural} of this job type, REMOVE them and replace with the ANCHOR PRODUCT above — do not keep them and add more on top.`,
    ``,
    isReplacement
      ? `  THIS IS A REPLACEMENT JOB. ${callerPossessive} photo shows their EXISTING fitting (the one being replaced). Your edited image MUST depict the NEW ANCHOR PRODUCT installed in place of the existing one. The output MUST look visibly DIFFERENT from the input photo${anchor ? ` — the new product (${anchor}) has a different style/finish/form from what is currently there, and that visual change MUST be apparent` : ''}. If your output looks IDENTICAL to the customer's input photo, you have failed the task — re-render and show the replacement.`
      : `  This is a NEW INSTALL. ${callerPossessive} photo shows the surface BEFORE installation. Your edited image must depict the ANCHOR PRODUCT newly installed in the appropriate position.`,
    ``,
    `  Watermark: a small "AI PREVIEW" mark in the bottom-right corner.`,
  ].join('\n')

  return {
    system: buildSystemInstruction(ctx, shotContext),
    user: `Generate the AI Preview image now using the attached reference photo. Remember: the final image MUST show the ANCHOR PRODUCT, not just return the input photo unchanged.`,
  }
}

// ════════════════════════════════════════════════════════════════════
// SAMPLE prompts
// ════════════════════════════════════════════════════════════════════

export type SamplePromptSet = {
  wide: SystemUserPrompt
  detail: SystemUserPrompt
  lit: SystemUserPrompt
}

export type SamplePromptOpts = {
  usePhotoReference?: boolean
}

export function buildSamplePrompts(ctx: PromptContext, opts: SamplePromptOpts = {}): SamplePromptSet | null {
  const room = detectRoom(ctx.intake.scope?.description) ?? 'room'
  const { plural: jobLabelPlural, singular: jobLabelSingular } = humaniseJobType(ctx.intake.job_type)
  const callerName = ctx.intake.caller?.name?.trim() || null
  const callerLabel = callerName ?? 'the customer'
  const callerPossessive = callerName ? `${callerName}'s` : `the customer's`
  const usingPhoto = opts.usePhotoReference === true

  // Cross-shot consistency directive — included verbatim in all 3
  // sample contexts so each Gemini call understands it's part of a
  // coordinated series and must depict the same product.
  const crossShotConsistency = `  CROSS-IMAGE CONSISTENCY — this is ONE of THREE coordinated sample images for the same quote (WIDE, CLOSE-UP, IN-USE). All three sample images MUST depict the SAME anchor product (named in the ANCHOR PRODUCT block above). Customers view the three side by side; they MUST see ONE consistent product from three different angles, NOT three different products. If the anchor is a wall-faced toilet suite, render a wall-faced toilet suite in all three shots — not close-coupled in one and wall-faced in another. Same product, same style, same finish across the series.`

  // ─── WIDE ───
  const wideShot = [
    `  Series role: WIDE-ANGLE OVERVIEW (image 1 of 3 in this sample series).`,
    `  A wide-angle view of ${usingPhoto ? `${callerPossessive} ${room} (reference photo attached)` : `a contemporary Australian ${room}`}, showing the entire space and EVERY one of the requested ${jobLabelPlural} in a single frame. All depicted fittings must be the ANCHOR PRODUCT.`,
    `  Camera ~3-4 metres back, eye-level, daylight ambient lighting.`,
    usingPhoto
      ? `  Match ${callerPossessive} actual walls, flooring, decor, and palette from the attached photo. Pull back wider than the photo if needed so every fitting fits.`
      : `  Generic Aussie home aesthetic: neutral walls, blonde-oak flooring, minimal furniture.`,
    crossShotConsistency,
    `  Watermark: a small "AI SAMPLE" mark in the bottom-right corner.`,
  ].join('\n')

  // ─── CLOSE-UP ───
  const detailShot = [
    `  Series role: MACRO CLOSE-UP (image 2 of 3 in this sample series).`,
    `  A macro product-photography close-up of ONE single instance of the ANCHOR PRODUCT. The fitting fills 60-80% of the frame. Camera ~30-50 cm from the fitting. Show face plate, trim, finish, surface texture in detail — exactly matching the anchor product's brand and style.`,
    usingPhoto
      ? `  Background: heavily-blurred bokeh sampled from ${callerPossessive} attached photo (their actual ${room}'s palette and materials). Background must NOT be in focus, and must NOT contain other ${jobLabelPlural}.`
      : `  Background: blurred ${room} surface, soft bokeh, no other ${jobLabelPlural} visible.`,
    `  This is NOT a room shot. NOT a wide. ONE ${jobLabelSingular} only — and it MUST be the same product depicted in the WIDE and IN-USE shots.`,
    crossShotConsistency,
    `  Watermark: a small "AI SAMPLE" mark in the bottom-right corner.`,
  ].join('\n')

  // ─── IN-USE / DUSK ───
  const litShot = [
    `  Series role: IN-USE / EVENING (image 3 of 3 in this sample series).`,
    `  ${usingPhoto ? `${callerPossessive.toUpperCase()} ${room.toUpperCase()} AT DUSK (reference photo attached)` : `A CONTEMPORARY AUSTRALIAN ${room.toUpperCase()} AT DUSK`} — the requested ${jobLabelPlural} (matching the ANCHOR PRODUCT) are visibly in their operational state (illuminated if light fittings; clearly mounted and active otherwise). Windows show deep blue/purple twilight outside. Soft cosy interior atmosphere.`,
    `  Camera ~3-4 metres back, similar framing to a wide shot. Every requested fitting visible in the frame, and it MUST be the same anchor product depicted in the WIDE and CLOSE-UP shots.`,
    usingPhoto
      ? `  KEY: this is ${callerPossessive} actual ${room} at evening. Match the photo's walls, floor, furniture, layout, perspective — only the time of day and the new fittings change. ${callerLabel} should recognise their own space.`
      : `  Generic Aussie home aesthetic at dusk.`,
    crossShotConsistency,
    `  Watermark: a small "AI SAMPLE" mark in the bottom-right corner.`,
  ].join('\n')

  const baseUser = usingPhoto
    ? `Generate the AI Sample image now using the attached reference photo. Remember: this image MUST depict the ANCHOR PRODUCT named in the system instruction, and it MUST match the product depicted in the other two sample shots (WIDE / CLOSE-UP / IN-USE).`
    : `Generate the AI Sample image now. Remember: this image MUST depict the ANCHOR PRODUCT named in the system instruction, and it MUST match the product depicted in the other two sample shots (WIDE / CLOSE-UP / IN-USE).`

  return {
    wide:   { system: buildSystemInstruction(ctx, wideShot),   user: baseUser },
    detail: { system: buildSystemInstruction(ctx, detailShot), user: baseUser },
    lit:    { system: buildSystemInstruction(ctx, litShot),    user: baseUser },
  }
}
