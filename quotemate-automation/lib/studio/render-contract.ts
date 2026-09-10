import { z } from 'zod'
import { STUDIO_PHOTOS } from './presets'
import { studioLocalGlyphs } from './local-glyphs'

// Defensive renderer ceilings, pending DEC04 contract sign-off. These are not
// provider quotas or promises that arbitrary copy will fit the fixed template.
export const STUDIO_COPY_BYTES = 16_384
export const STUDIO_TEXT_LENGTH = 500
export const STUDIO_LIST_LENGTH = 6
export const STUDIO_PNG_BYTES = 1080 * 1350 * 4 + 65_536

export const STUDIO_ASSETS = Object.freeze(Object.fromEntries(
  STUDIO_PHOTOS.map((id) => [`/studio/photos/${id}.png`, `studio/photos/${id}.png`]),
)) as Readonly<Record<string, string>>

const text = z.string().max(STUDIO_TEXT_LENGTH).refine(studioLocalGlyphs)
// The established CTA arrow is drawn as a local SVG in the template.
const button = z.string().max(STUDIO_TEXT_LENGTH).refine((value) => studioLocalGlyphs(value.replaceAll('→', '')))
const labels = z.array(text).max(STUDIO_LIST_LENGTH)
const photo = z.object({
  src: z.string().refine((src) => Object.hasOwn(STUDIO_ASSETS, src)),
  pos: z.enum(['center', 'center 28%', 'center 36%', 'right 20%']).optional(),
  scrim: z.enum(['top', 'left', 'faint']).optional(),
}).strict().nullable().optional()
const chrome = { photo, eyebrow: labels.optional(), bar: labels.optional() }

export const StudioSlideSchema = z.discriminatedUnion('kind', [
  z.object({ ...chrome, kind: z.literal('stat'), lines: z.array(z.tuple([text, text])).length(3), sub: text.optional(), proof: labels.optional() }).strict(),
  z.object({ ...chrome, kind: z.literal('list'), h: text, cards: z.array(z.tuple([text, text])).length(3), sub: text.optional() }).strict(),
  z.object({ ...chrome, kind: z.literal('steps'), h: text, steps: z.array(z.tuple([text, text, text])).length(3) }).strict(),
  z.object({ ...chrome, kind: z.literal('quote'), quote: text, attrib: labels }).strict(),
  z.object({ ...chrome, kind: z.literal('cta'), h: text, sub: text.optional(), btn: button, foot: labels.optional() }).strict(),
])

export const StudioRenderSchema = z.object({
  format: z.literal('li-carousel'),
  slide: StudioSlideSchema,
}).strict()
export type StudioRenderInput = z.infer<typeof StudioRenderSchema>

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)
}
