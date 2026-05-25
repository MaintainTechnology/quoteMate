// Item 4 — image-config is pure byte-parsing + nearest-ratio maths, so
// it is fully unit-testable with synthetic image headers. A wrong
// aspect ratio reframes the customer's photo, so the nearest-match
// logic and the PNG/JPEG header parsers both need coverage.

import { describe, expect, it } from 'vitest'
import {
  aspectRatioFromImage,
  deriveAspectRatio,
  readImageSize,
  SUPPORTED_ASPECT_RATIOS,
} from './image-config'

// ── Synthetic headers ──────────────────────────────────────────────

/** Minimal 24-byte PNG: signature + IHDR length/tag + width + height. */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) // signature
  b.writeUInt32BE(13, 8) // IHDR chunk length
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

/** Minimal JPEG: SOI + SOF0 frame header carrying height then width. */
function jpegHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(32)
  b[0] = 0xff
  b[1] = 0xd8 // SOI
  b[2] = 0xff
  b[3] = 0xc0 // SOF0
  b.writeUInt16BE(17, 4) // segment length
  b[6] = 8 // sample precision
  b.writeUInt16BE(height, 7)
  b.writeUInt16BE(width, 9)
  return b
}

describe('deriveAspectRatio', () => {
  it('maps common photo dimensions to the nearest supported ratio', () => {
    expect(deriveAspectRatio(1920, 1080)).toBe('16:9')
    expect(deriveAspectRatio(1080, 1920)).toBe('9:16')
    expect(deriveAspectRatio(1000, 1000)).toBe('1:1')
    expect(deriveAspectRatio(4032, 3024)).toBe('4:3') // typical phone landscape
    expect(deriveAspectRatio(3024, 4032)).toBe('3:4') // typical phone portrait
    expect(deriveAspectRatio(3440, 1440)).toBe('21:9')
  })

  it('snaps a slightly-off ratio to the closest supported one', () => {
    // 1300x1000 = 1.30, closest to 4:3 (1.333) not 5:4 (1.25)
    expect(deriveAspectRatio(1300, 1000)).toBe('4:3')
    const r = deriveAspectRatio(1290, 1000) // 1.29 — closer to 5:4 (1.25)
    expect(r).toBe('5:4')
  })

  it('always returns a value from the supported set', () => {
    const r = deriveAspectRatio(1234, 567)
    expect(r).not.toBeNull()
    expect(SUPPORTED_ASPECT_RATIOS).toContain(r!)
  })

  it('returns null for invalid dimensions', () => {
    expect(deriveAspectRatio(0, 100)).toBeNull()
    expect(deriveAspectRatio(100, 0)).toBeNull()
    expect(deriveAspectRatio(-10, 100)).toBeNull()
    expect(deriveAspectRatio(NaN, 100)).toBeNull()
    expect(deriveAspectRatio(100, Infinity)).toBeNull()
  })
})

describe('readImageSize', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    expect(readImageSize(pngHeader(1600, 1200))).toEqual({ width: 1600, height: 1200 })
    expect(readImageSize(pngHeader(800, 800))).toEqual({ width: 800, height: 800 })
  })

  it('reads JPEG dimensions from the SOF0 frame header', () => {
    expect(readImageSize(jpegHeader(4032, 3024))).toEqual({ width: 4032, height: 3024 })
    expect(readImageSize(jpegHeader(640, 480))).toEqual({ width: 640, height: 480 })
  })

  it('returns null for buffers that are too short', () => {
    expect(readImageSize(Buffer.alloc(10))).toBeNull()
  })

  it('returns null for an unrecognised format', () => {
    expect(readImageSize(Buffer.alloc(64, 0x42))).toBeNull()
  })
})

describe('aspectRatioFromImage', () => {
  it('derives the aspect ratio directly from PNG bytes', () => {
    expect(aspectRatioFromImage(pngHeader(1920, 1080))).toBe('16:9')
  })

  it('derives the aspect ratio directly from JPEG bytes', () => {
    expect(aspectRatioFromImage(jpegHeader(3024, 4032))).toBe('3:4')
  })

  it('returns null when the bytes are not a recognised image', () => {
    expect(aspectRatioFromImage(Buffer.alloc(64, 0x00))).toBeNull()
  })
})
