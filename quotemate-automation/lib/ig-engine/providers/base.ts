// ════════════════════════════════════════════════════════════════════
// IG Engine — provider interface.
//
// Each adapter implements this contract so the engine (pipeline.ts +
// the legacy generate.ts / samples.ts entry points) can dispatch a
// render to any provider without touching its native API.
//
// Today: Gemini (in-place edits + text-to-image + vision/text for the
// judge). Coming: OpenAI gpt-image-2 via Vercel AI Gateway.
//
// PURE TYPES — no I/O — fully testable.
// ════════════════════════════════════════════════════════════════════

export type ImageBytes = { base64: string; mime: string }

/** A labelled secondary reference image (e.g. the exact product photo)
 *  attached after the source image with its own preceding text label. */
export type ReferenceImage = {
  image: ImageBytes
  /** Provider injects this text immediately before the reference image,
   *  so the model knows *why* the extra image is attached. */
  label: string
}

/** A single image-render request — provider-agnostic. */
export type RenderImageRequest = {
  /** Authoritative system-level instructions. */
  system: string
  /** User-facing brief. */
  user: string
  /** Source image to edit. Omit for text-to-image. */
  sourceImage?: ImageBytes
  /** Optional secondary reference image with its preceding label. */
  reference?: ReferenceImage
  /** Extra hard wording appended to the user message — the stricter
   *  re-render path (verify-loop feedback). */
  extraStrict?: string
  /** Output aspect ratio, e.g. '16:9'. Omit for provider default. */
  aspectRatio?: string
  /** Temperature override. Default low (0.1) — follow the brief tightly. */
  temperature?: number
  /** Override the provider's default model for this call. */
  model?: string
}

/** A vision+text request used for judging a rendered image. */
export type TextRequest = {
  prompt: string
  /** Images attached as input (rendered preview, optional product ref). */
  images?: ImageBytes[]
  /** Temperature override. Default 0 — judges should not be creative. */
  temperature?: number
  /** Override the provider's default model for this call. */
  model?: string
}

export type ProviderCapabilities = {
  /** Can edit an existing image while preserving the rest. */
  edit: boolean
  /** Can generate images from text only. */
  textToImage: boolean
  /** Can take images as input and produce text (judging). */
  vision: boolean
}

export type ProviderName = 'gemini' | 'openai'

export interface ImageProvider {
  readonly name: ProviderName
  readonly capabilities: ProviderCapabilities
  /** Generate or edit an image. Throws on API failure. */
  renderImage(req: RenderImageRequest): Promise<ImageBytes>
  /** Vision+text — used by the judge. Optional; provider may omit. */
  generateText?(req: TextRequest): Promise<string>
}
