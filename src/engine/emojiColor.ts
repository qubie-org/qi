/**
 * The turn's emoji picks the turn's colour.
 *
 * Rather than deciding a hue from a conversation-level scalar and hoping it
 * suits, the accent is taken from whatever the reply actually shows: a 🔥 turn
 * runs red, 🌊 blue, 🌲 green, 🍞 gold. The picture and the palette then agree
 * by construction, and the agent — which already chooses the emoji from real
 * context — is choosing the colour too without being asked to think about
 * colour at all.
 *
 * Sampled from the rendered glyph, not a lookup table. A table would need
 * 1,400 hand-checked entries and would still be wrong on whichever platform
 * draws its emoji differently from the one it was built on.
 */

const cache = new Map<string, string | null>()

/**
 * Dominant hue of an emoji, as an OKLCH string, or null if it has no useful
 * colour (mostly-grey glyphs like ⚙️ would otherwise drag the theme to mud).
 */
export function colorOf(glyph: string, size = 24): string | null {
  const hit = cache.get(glyph)
  if (hit !== undefined) return hit

  const value = sample(glyph, size)
  cache.set(glyph, value)
  return value
}

function sample(glyph: string, size: number): string | null {
  let canvas: HTMLCanvasElement
  try {
    canvas = document.createElement('canvas')
  } catch {
    return null // no DOM (tests, workers)
  }
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  ctx.clearRect(0, 0, size, size)
  ctx.font = `${size * 0.85}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(glyph, size / 2, size / 2)

  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, size, size).data
  } catch {
    return null // tainted canvas
  }

  // Average hue as a vector sum, weighted by saturation. Averaging hue angles
  // arithmetically is wrong — red at 5° and 355° would average to cyan — so
  // they are summed as unit vectors and the mean direction taken.
  let x = 0
  let y = 0
  let weight = 0
  let lightSum = 0
  let lightN = 0

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a < 40) continue
    const r = data[i] / 255
    const g = data[i + 1] / 255
    const b = data[i + 2] / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const light = (max + min) / 2
    lightSum += light
    lightN++
    const chroma = max - min
    if (chroma < 0.12) continue // grey pixels carry no hue

    let hue: number
    if (max === r) hue = ((g - b) / chroma) % 6
    else if (max === g) hue = (b - r) / chroma + 2
    else hue = (r - g) / chroma + 4
    hue *= 60
    if (hue < 0) hue += 360

    const w = chroma * (a / 255)
    x += Math.cos((hue * Math.PI) / 180) * w
    y += Math.sin((hue * Math.PI) / 180) * w
    weight += w
  }

  if (!weight || weight < 0.6) return null // too grey to theme from

  let hue = (Math.atan2(y, x) * 180) / Math.PI
  if (hue < 0) hue += 360
  // sRGB hue and OKLCH hue disagree; this shifts the common cases into place
  // well enough for an accent, without a full colour-space conversion.
  const oklch = (hue + 25) % 360
  const lightness = lightN ? Math.min(0.68, Math.max(0.52, lightSum / lightN)) : 0.6

  return `oklch(${(lightness * 100).toFixed(1)}% 0.19 ${oklch.toFixed(1)})`
}
