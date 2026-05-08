// ═══════════════════════════════════════════════════════════════════
// AI preview prompts — per job_type templates for Gemini 2.5 Flash Image.
//
// The prompt always emphasises that the attached photo is the CUSTOMER'S
// REAL ROOM and that Gemini should EDIT IT (not generate a new scene
// from scratch). Same room, same angle, same lighting, same furniture
// — only the relevant fixtures change.
// ═══════════════════════════════════════════════════════════════════

export type PromptIntake = {
  job_type: string
  scope?: {
    item_count?: number | null
    description?: string | null
    color_temp?: string | null
    dimmable?: boolean | null
  } | null
  access?: {
    ceiling_type?: string | null
    wall_type?: string | null
  } | null
  caller?: { name?: string | null } | null
}

// Best-effort room name extracted from the structured scope description.
// Fallback to "room" so prompts never read "in your null".
function detectRoom(desc?: string | null): string {
  if (!desc) return 'room'
  const m = desc.match(/\b(lounge|living\s*room|kitchen|bedroom|bathroom|dining|study|hallway|garage|deck|patio|courtyard|backyard|laundry)\b/i)
  return m ? m[1].toLowerCase().replace(/\s+/g, ' ') : 'room'
}

// Map common color-temp phrases to a Kelvin range Gemini can render reliably.
function colorTempHint(temp?: string | null): string {
  if (!temp) return '2700K-3000K (warm white)'
  if (/cool/i.test(temp)) return '4000K-5000K (cool white)'
  if (/tri/i.test(temp)) return '3000K-5000K (tri-colour, render as warm 3000K)'
  if (/daylight|natural/i.test(temp)) return '5000K-6500K (daylight)'
  return '2700K-3000K (warm white)'
}

// Universal footer applied to every prompt.
function footerText(): string {
  return [
    `KEEP UNCHANGED: room layout, walls, floor, furniture, decor, ambient lighting, perspective, camera angle.`,
    `MODIFY ONLY: the specific fixture area listed above.`,
    `STYLE: photorealistic, modern Australian residential interior. Match the lighting + colour grading of the input photo.`,
    `WATERMARK: add a small semi-transparent "AI PREVIEW" watermark in the bottom-right corner.`,
    `OUTPUT: a single edited image, same aspect ratio + resolution as the input photo.`,
  ].join('\n')
}

export function buildPreviewPrompt(intake: PromptIntake): string {
  const room = detectRoom(intake.scope?.description)
  const count = intake.scope?.item_count ?? 0
  const ceiling = intake.access?.ceiling_type ?? 'flat plaster'
  const wallType = intake.access?.wall_type ?? 'plaster'
  const tempK = colorTempHint(intake.scope?.color_temp)
  const dimmable = intake.scope?.dimmable === true ? 'dimmable' : 'non-dimmable'

  const header = [
    `You are an interior visualisation assistant for an Australian electrical contractor's customer preview.`,
    ``,
    `THE ATTACHED IMAGE IS THE CUSTOMER'S ACTUAL ROOM — taken before any electrical work has been done. Your job is to EDIT THAT IMAGE to show what it would look like with the proposed work completed. Treat it as the base scene, not as inspiration. Keep everything else identical.`,
    ``,
  ].join('\n')

  switch (intake.job_type) {
    case 'downlights':
      return [
        header,
        `PROPOSED WORK:`,
        `- Install ${count || 'several'} LED downlights`,
        `- Evenly spaced across the ${ceiling} ceiling`,
        `- ${tempK} colour temperature, ${dimmable}`,
        `- Lights ON in the rendered output (so the new fittings are visible)`,
        ``,
        `FIXTURE AREA: the ${ceiling} ceiling. Add the new downlight cut-outs at sensible spacing for the room size shown. If existing fittings are visible in the photo, treat them as being replaced.`,
        ``,
        footerText(),
      ].join('\n')

    case 'power_points':
      return [
        header,
        `PROPOSED WORK:`,
        `- Install ${count || 'several'} double GPO (general purpose outlets / power points)`,
        `- White face plates, standard Australian AS/NZS 3112 style`,
        `- Mounted on the ${wallType} wall(s) at standard height (~30cm above skirting)`,
        ``,
        `FIXTURE AREA: visible wall area in the photo. Place the GPOs at sensible heights and spacing. If existing GPOs are visible, treat them as being replaced/added to.`,
        ``,
        footerText(),
      ].join('\n')

    case 'ceiling_fans':
      return [
        header,
        `PROPOSED WORK:`,
        `- Install ${count || 'a'} ceiling fan(s)`,
        `- Centred on the ${ceiling} ceiling`,
        `- Modern 3-blade or 4-blade design, matte white or brushed nickel finish`,
        `- Optional integrated light fitting`,
        ``,
        `FIXTURE AREA: centre of the ${ceiling} ceiling visible in the photo. Render the fan motionless from a neutral angle.`,
        ``,
        footerText(),
      ].join('\n')

    case 'smoke_alarms':
      return [
        header,
        `PROPOSED WORK:`,
        `- Install ${count || 'several'} hardwired photoelectric smoke alarms`,
        `- White, low-profile, ~10cm diameter, AS 3786 compliant`,
        `- Positioned on the ${ceiling} ceiling at the centre of the room or hallway shown`,
        ``,
        `FIXTURE AREA: the ${ceiling} ceiling. Render small, unobtrusive alarms at standard positions.`,
        ``,
        footerText(),
      ].join('\n')

    case 'outdoor_lighting':
      return [
        header,
        `PROPOSED WORK:`,
        `- Install ${count || 'several'} outdoor LED light fittings`,
        `- IP-rated, weatherproof, mounted on the eaves / wall / deck area visible in the photo`,
        `- ${tempK} colour temperature`,
        `- Lights ON in the rendered output (warm evening glow if the photo is daytime — render as if dusk for visibility)`,
        ``,
        `FIXTURE AREA: outdoor wall, eaves, or deck area visible in the photo. Place fittings at standard mounting positions.`,
        ``,
        footerText(),
      ].join('\n')

    default:
      // Inspection-required jobs and other unknown types — caller should
      // skip preview generation, but render a generic prompt as fallback
      // just in case it's invoked.
      return [
        header,
        `PROPOSED WORK:`,
        `- Electrical work as described: ${intake.scope?.description ?? '(unspecified)'}`,
        ``,
        footerText(),
      ].join('\n')
  }
}
