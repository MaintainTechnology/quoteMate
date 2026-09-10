// Intersection of the six bundled WOFF cmap tables, checked with fontTools.
// Validate before loading assets: next/og otherwise sends unsupported custom
// text to its external fallback-font service. Uppercase is checked too because
// several fixed templates transform headings/labels during rendering.
const extra = new Set([258, 305, 338, 339, 710, 730, 732, 8211, 8212, 8216, 8217, 8218, 8220, 8221, 8222, 8226, 8230, 8249, 8250, 8260, 8364, 8482, 8593, 8595, 8722, 8725])
export function studioLocalGlyphs(text: string): boolean {
  return Array.from(text + text.toUpperCase()).every((char) => {
    const code = char.codePointAt(0)!
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255) || extra.has(code)
  })
}
