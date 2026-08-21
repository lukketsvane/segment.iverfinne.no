/**
 * Canvas plumbing shared by the worker and the main-thread fallback, plus the
 * float resampling the matte maths needs (canvas can only carry 8-bit values,
 * and the guided filter's coefficients do not fit in that range).
 */

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

export type Surface = { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx2D }

const hasOffscreen = typeof OffscreenCanvas !== "undefined"

export function surface(width: number, height: number): Surface {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  if (hasOffscreen) {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) throw new Error("2D canvas is unavailable.")
    return { canvas, ctx }
  }
  if (typeof document === "undefined") throw new Error("2D canvas is unavailable.")
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) throw new Error("2D canvas is unavailable.")
  return { canvas, ctx }
}

/** Draws a source region scaled into a fresh w×h buffer and reads it back. */
export function rasterize(
  source: CanvasImageSource,
  region: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): ImageData {
  const { ctx } = surface(width, height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height)
}

/**
 * Precomputed bilinear taps for one axis: for each destination index, the two
 * source indices and the weight between them. Hoisting this out of the inner
 * loop is what makes the full-resolution pass affordable on a phone.
 */
export type Taps = { lo: Int32Array; hi: Int32Array; frac: Float32Array }

export function bilinearTaps(srcLen: number, dstLen: number): Taps {
  const lo = new Int32Array(dstLen)
  const hi = new Int32Array(dstLen)
  const frac = new Float32Array(dstLen)
  const ratio = srcLen / dstLen
  for (let i = 0; i < dstLen; i++) {
    // Sample at destination pixel centres, mapped into source space.
    const t = Math.min(srcLen - 1, Math.max(0, (i + 0.5) * ratio - 0.5))
    const base = Math.floor(t)
    lo[i] = base
    hi[i] = Math.min(srcLen - 1, base + 1)
    frac[i] = t - base
  }
  return { lo, hi, frac }
}

/** Bilinear resample of a single-channel float image. */
export function resample(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  out = new Float32Array(dw * dh),
): Float32Array {
  if (sw === dw && sh === dh) {
    out.set(src)
    return out
  }
  const cols = bilinearTaps(sw, dw)
  const rows = bilinearTaps(sh, dh)
  for (let y = 0; y < dh; y++) {
    const r0 = rows.lo[y] * sw
    const r1 = rows.hi[y] * sw
    const fy = rows.frac[y]
    const base = y * dw
    for (let x = 0; x < dw; x++) {
      const x0 = cols.lo[x]
      const x1 = cols.hi[x]
      const fx = cols.frac[x]
      const top = src[r0 + x0] + (src[r0 + x1] - src[r0 + x0]) * fx
      const bottom = src[r1 + x0] + (src[r1 + x1] - src[r1 + x0]) * fx
      out[base + x] = top + (bottom - top) * fy
    }
  }
  return out
}
