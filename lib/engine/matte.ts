/**
 * Turns a coarse network matte into a finished one.
 *
 * A saliency network answers "which pixels belong to the subject" at 1024², so
 * its matte arrives soft, low resolution and blind to the actual image edges.
 * Three things fix that, all of them cheap next to inference:
 *
 *  1. A guided filter (He et al.) re-fits the matte to the photo's own edges, so
 *     a boundary lands on the strand of hair rather than near it.
 *  2. The refinement is confined to a band around the matte boundary. Left
 *     unbounded, a guided filter degenerates into a box blur wherever the guide
 *     is flat, which smears alpha into empty background as a visible halo.
 *  3. Foreground colour estimation undoes background bleed. A partly
 *     transparent pixel observed as C = aF + (1-a)B still carries the old
 *     background's colour; composited on white it shows up as a dark fringe.
 *
 * Everything but the final pass runs on a subsampled copy — the fast guided
 * filter's whole point is that its coefficients are smooth enough to compute
 * small and upsample.
 */
import { bilinearTaps, resample } from "./raster"

/** Interleaved per-pixel coefficients: guide slope (3), intercept, near-foreground (3), near-background (3). */
const COEF = 10

export type Coefficients = { data: Float32Array; width: number; height: number }

/** Separable moving average with clamped edges. Two O(n) passes, radius-independent. */
function boxBlur(src: Float32Array, w: number, h: number, r: number, out: Float32Array, tmp: Float32Array) {
  const norm = 1 / (2 * r + 1)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = src[row] * (r + 1)
    for (let i = 1; i <= r; i++) sum += src[row + Math.min(i, w - 1)]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * norm
      sum += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)]
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = tmp[x] * (r + 1)
    for (let i = 1; i <= r; i++) sum += tmp[Math.min(i, h - 1) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * norm
      sum += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x]
    }
  }
  return out
}

/**
 * Marks how far the refinement is allowed to move alpha: 1 within `radius` of a
 * partly transparent pixel, 0 where the coarse matte is already committed.
 */
export function bandWeight(alpha: Float32Array, w: number, h: number, radius: number): Uint8Array {
  const edge = new Float32Array(w * h)
  for (let i = 0; i < edge.length; i++) edge[i] = alpha[i] > 0.03 && alpha[i] < 0.97 ? 1 : 0
  const blurred = boxBlur(edge, w, h, Math.max(1, radius), new Float32Array(w * h), new Float32Array(w * h))
  const band = new Uint8Array(w * h)
  // A boundary pixel only ever occupies a sliver of the blur window, so the
  // response is scaled up and clipped rather than used raw.
  for (let i = 0; i < band.length; i++) band[i] = Math.min(255, blurred[i] * 8 * 255)
  return band
}

/**
 * Fits alpha = a·I + b over every window of the subsampled guide, and gathers
 * the local foreground/background colours used for decontamination.
 */
export function fitCoefficients(
  guide: ImageData,
  alphaFull: Float32Array,
  fullWidth: number,
  fullHeight: number,
  radius: number,
  eps: number,
): Coefficients {
  const w = guide.width
  const h = guide.height
  const n = w * h
  const px = guide.data

  const Ir = new Float32Array(n)
  const Ig = new Float32Array(n)
  const Ib = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    Ir[i] = px[i * 4] / 255
    Ig[i] = px[i * 4 + 1] / 255
    Ib[i] = px[i * 4 + 2] / 255
  }
  const P = resample(alphaFull, fullWidth, fullHeight, w, h)

  const tmp = new Float32Array(n)
  const blur = (src: Float32Array, r: number) => boxBlur(src, w, h, r, new Float32Array(n), tmp)
  const product = (a: Float32Array, b: Float32Array) => {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = a[i] * b[i]
    return out
  }

  const mR = blur(Ir, radius)
  const mG = blur(Ig, radius)
  const mB = blur(Ib, radius)
  const mP = blur(P, radius)

  const covR = blur(product(Ir, P), radius)
  const covG = blur(product(Ig, P), radius)
  const covB = blur(product(Ib, P), radius)

  const vRR = blur(product(Ir, Ir), radius)
  const vRG = blur(product(Ir, Ig), radius)
  const vRB = blur(product(Ir, Ib), radius)
  const vGG = blur(product(Ig, Ig), radius)
  const vGB = blur(product(Ig, Ib), radius)
  const vBB = blur(product(Ib, Ib), radius)

  const a0 = new Float32Array(n)
  const a1 = new Float32Array(n)
  const a2 = new Float32Array(n)
  const b = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const cr = covR[i] - mR[i] * mP[i]
    const cg = covG[i] - mG[i] * mP[i]
    const cb = covB[i] - mB[i] * mP[i]

    // Symmetric 3×3 colour covariance, ridged by eps so flat windows stay solvable.
    const s00 = vRR[i] - mR[i] * mR[i] + eps
    const s01 = vRG[i] - mR[i] * mG[i]
    const s02 = vRB[i] - mR[i] * mB[i]
    const s11 = vGG[i] - mG[i] * mG[i] + eps
    const s12 = vGB[i] - mG[i] * mB[i]
    const s22 = vBB[i] - mB[i] * mB[i] + eps

    const c00 = s11 * s22 - s12 * s12
    const c01 = s02 * s12 - s01 * s22
    const c02 = s01 * s12 - s02 * s11
    const det = s00 * c00 + s01 * c01 + s02 * c02

    if (det > 1e-12) {
      const inv = 1 / det
      const c11 = s00 * s22 - s02 * s02
      const c12 = s01 * s02 - s00 * s12
      const c22 = s00 * s11 - s01 * s01
      a0[i] = (c00 * cr + c01 * cg + c02 * cb) * inv
      a1[i] = (c01 * cr + c11 * cg + c12 * cb) * inv
      a2[i] = (c02 * cr + c12 * cg + c22 * cb) * inv
    }
    b[i] = mP[i] - a0[i] * mR[i] - a1[i] * mG[i] - a2[i] * mB[i]
  }

  const ma0 = blur(a0, radius)
  const ma1 = blur(a1, radius)
  const ma2 = blur(a2, radius)
  const mb = blur(b, radius)

  // Nearby foreground and background colours, alpha-weighted. The wider radius
  // gives an edge pixel a chance to reach genuinely opaque neighbours.
  const wide = radius * 2 + 2
  const inverse = new Float32Array(n)
  for (let i = 0; i < n; i++) inverse[i] = 1 - P[i]
  const wF = blur(P, wide)
  const wB = blur(inverse, wide)
  const fR = blur(product(Ir, P), wide)
  const fG = blur(product(Ig, P), wide)
  const fB = blur(product(Ib, P), wide)
  const bR = blur(product(Ir, inverse), wide)
  const bG = blur(product(Ig, inverse), wide)
  const bB = blur(product(Ib, inverse), wide)

  const data = new Float32Array(n * COEF)
  for (let i = 0; i < n; i++) {
    const o = i * COEF
    const wf = Math.max(wF[i], 1e-4)
    const wb = Math.max(wB[i], 1e-4)
    data[o] = ma0[i]
    data[o + 1] = ma1[i]
    data[o + 2] = ma2[i]
    data[o + 3] = mb[i]
    data[o + 4] = fR[i] / wf
    data[o + 5] = fG[i] / wf
    data[o + 6] = fB[i] / wf
    data[o + 7] = bR[i] / wb
    data[o + 8] = bG[i] / wb
    data[o + 9] = bB[i] / wb
  }
  return { data, width: w, height: h }
}

/**
 * The one full-resolution pass: upsamples the coefficients, applies them to the
 * guide, blends against the coarse matte inside the band, remaps levels, undoes
 * the background bleed, and writes straight-alpha RGBA.
 */
export function composeMatte(
  image: ImageData,
  alpha: Float32Array,
  band: Uint8Array,
  coefficients: Coefficients,
  levels: readonly [number, number],
  out: Uint8ClampedArray,
) {
  const w = image.width
  const h = image.height
  const px = image.data
  const { data: coef, width: cw, height: ch } = coefficients
  const cols = bilinearTaps(cw, w)
  const rows = bilinearTaps(ch, h)
  const [low, high] = levels
  const span = 1 / Math.max(1e-6, high - low)
  const c = new Float32Array(COEF)

  for (let y = 0; y < h; y++) {
    const r0 = rows.lo[y] * cw
    const r1 = rows.hi[y] * cw
    const fy = rows.frac[y]
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const o0 = (r0 + cols.lo[x]) * COEF
      const o1 = (r0 + cols.hi[x]) * COEF
      const o2 = (r1 + cols.lo[x]) * COEF
      const o3 = (r1 + cols.hi[x]) * COEF
      const fx = cols.frac[x]
      for (let k = 0; k < COEF; k++) {
        const top = coef[o0 + k] + (coef[o1 + k] - coef[o0 + k]) * fx
        const bottom = coef[o2 + k] + (coef[o3 + k] - coef[o2 + k]) * fx
        c[k] = top + (bottom - top) * fy
      }

      const p = i * 4
      const sr = px[p] / 255
      const sg = px[p + 1] / 255
      const sb = px[p + 2] / 255

      const fitted = c[0] * sr + c[1] * sg + c[2] * sb + c[3]
      const weight = band[i] / 255
      let a = alpha[i] + (fitted - alpha[i]) * weight
      a = (a - low) * span
      a = a < 0 ? 0 : a > 1 ? 1 : a

      if (a <= 0.002) {
        out[p] = 0
        out[p + 1] = 0
        out[p + 2] = 0
        out[p + 3] = 0
        continue
      }

      // Solve C = aF + (1-a)B for F, using the local background estimate. Where
      // alpha is too small to divide by, fall back to the nearest foreground
      // colour; where it is already opaque, keep the pixel untouched.
      const invA = 1 / Math.max(a, 1e-3)
      const rest = 1 - a
      const trust = Math.min(1, Math.max(0, (a - 0.05) * 4))
      const keep = Math.min(1, Math.max(0, (a - 0.9) * 10))
      const blend = (value: number, near: number, back: number) => {
        const solved = (value - rest * back) * invA
        const estimate = trust * solved + (1 - trust) * near
        const mixed = keep * value + (1 - keep) * estimate
        return mixed < 0 ? 0 : mixed > 1 ? 255 : mixed * 255
      }

      out[p] = blend(sr, c[4], c[7])
      out[p + 1] = blend(sg, c[5], c[8])
      out[p + 2] = blend(sb, c[6], c[9])
      out[p + 3] = a * 255
    }
  }
}
