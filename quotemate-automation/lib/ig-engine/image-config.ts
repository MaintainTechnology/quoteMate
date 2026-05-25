// ════════════════════════════════════════════════════════════════════
// Item 4 — derive a Gemini imageConfig.aspectRatio from the customer's
// source photo.
//
// WHY: when Gemini renders an edit without an explicit aspectRatio it
// defaults to its own framing (often 1:1), which crops or reframes the
// customer's photo — a likely contributor to "the product is positioned
// wrong". Passing the source photo's nearest supported aspect ratio
// keeps the edited preview framed like the original room shot.
//
// PURE — no I/O, no SDK, no deps. Reads PNG / JPEG pixel dimensions
// straight from the byte headers. Fully unit-tested (image-config.test.ts).
// Anything unrecognised returns null and the caller simply omits
// imageConfig (→ identical to today's behaviour, no regression).
// ════════════════════════════════════════════════════════════════════

export type ImageSize = { width: number; height: number }

// Aspect ratios accepted by gemini-3-pro-image-preview. Source:
// ai.google.dev/gemini-api/docs/image-generation.
export const SUPPORTED_ASPECT_RATIOS = [
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
] as const
export type AspectRatio = (typeof SUPPORTED_ASPECT_RATIOS)[number]

const RATIO_VALUE: Record<AspectRatio, number> = {
  '1:1': 1,
  '2:3': 2 / 3,
  '3:2': 3 / 2,
  '3:4': 3 / 4,
  '4:3': 4 / 3,
  '4:5': 4 / 5,
  '5:4': 5 / 4,
  '9:16': 9 / 16,
  '16:9': 16 / 9,
  '21:9': 21 / 9,
}

/**
 * The nearest supported aspect ratio for a width×height image.
 * Distance is measured in log-space so (e.g.) 3:2 vs 2:3 are treated
 * symmetrically and the match is perceptually even. null on bad input.
 */
export function deriveAspectRatio(
  width: number,
  height: number,
): AspectRatio | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width <= 0 || height <= 0) return null
  const target = Math.log(width / height)
  let best: AspectRatio = '1:1'
  let bestDist = Infinity
  for (const r of SUPPORTED_ASPECT_RATIOS) {
    const dist = Math.abs(Math.log(RATIO_VALUE[r]) - target)
    if (dist < bestDist) {
      bestDist = dist
      best = r
    }
  }
  return best
}

/**
 * Read pixel dimensions from PNG or JPEG bytes. Returns null for any
 * other / corrupt format — the caller then omits imageConfig.
 */
export function readImageSize(buf: Buffer | Uint8Array): ImageSize | null {
  if (!buf || buf.length < 24) return null
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)

  // ── PNG ── 8-byte signature, then the IHDR chunk. width / height are
  // big-endian uint32 at fixed offsets 16 and 20.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const width = b.readUInt32BE(16)
    const height = b.readUInt32BE(20)
    return width > 0 && height > 0 ? { width, height } : null
  }

  // ── JPEG ── starts FF D8. Walk segment markers until the SOFn frame
  // header, which carries height then width as big-endian uint16.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2
    while (offset < b.length) {
      if (b[offset] !== 0xff) {
        offset++
        continue
      }
      // Collapse runs of FF padding bytes between segments.
      while (offset < b.length && b[offset] === 0xff) offset++
      if (offset >= b.length) break
      const marker = b[offset]
      offset++
      // Standalone markers carry no length payload.
      if (
        marker === 0xd8 ||
        marker === 0xd9 ||
        marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        continue
      }
      if (offset + 2 > b.length) break
      const segLen = b.readUInt16BE(offset)
      if (segLen < 2) break
      // SOF0..SOF15 (0xC0–0xCF) excluding DHT(C4), JPG(C8), DAC(CC).
      const isSOF =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      if (isSOF) {
        if (offset + 7 > b.length) break
        const height = b.readUInt16BE(offset + 3)
        const width = b.readUInt16BE(offset + 5)
        return width > 0 && height > 0 ? { width, height } : null
      }
      offset += segLen
    }
    return null
  }

  return null
}

/**
 * Convenience: nearest supported aspect ratio straight from image bytes.
 * null when the format is unrecognised — caller omits imageConfig.
 */
export function aspectRatioFromImage(
  buf: Buffer | Uint8Array,
): AspectRatio | null {
  const size = readImageSize(buf)
  return size ? deriveAspectRatio(size.width, size.height) : null
}
