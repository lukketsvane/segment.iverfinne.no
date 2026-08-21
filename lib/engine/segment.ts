/**
 * The image pipeline: decode, locate the subject, zoom in on it for a second
 * look, refine the matte against the photo's own edges, and hand back straight
 * alpha RGBA.
 */
import { bandWeight, composeMatte, fitCoefficients } from "./matte"
import type { ModelId } from "./models"
import type { Backend } from "./plan"
import { rasterize, resample } from "./raster"
import type { Runner } from "./runtime"

/**
 * iPhone photos run 12-48MP while iOS Safari caps canvas area far below that,
 * so a full-resolution pipeline produces blank output and huge memory spikes.
 * The networks see 1024² regardless, and the refinement pass reads the guide at
 * this size, so capping the long edge here costs nothing visible.
 */
export const MAX_WORK_EDGE = 2048

/** Guide resolution for the fast guided filter — its coefficients are smooth by construction. */
const GUIDE_EDGE = 512
const GUIDE_RADIUS = 4
/** Ridge on the colour covariance. Small keeps edges crisp; too small makes flat windows unstable. */
const GUIDE_EPS = 1e-5
/** How far, as a fraction of the long edge, refinement may move the boundary. */
const BAND_FRACTION = 0.012

/** Skip the zoom pass once the subject already fills this much of the frame — there is no detail left to win. */
const ZOOM_CEILING = 0.7
/** Breathing room around the located subject, so the second pass sees context and not a hard crop. */
const ZOOM_MARGIN = 0.06

export type SegmentResult = {
  data: Uint8ClampedArray
  width: number
  height: number
  model: ModelId
  backend: Backend
  /** True when the subject was worth a second, zoomed inference pass. */
  zoomed: boolean
}

type Box = { x: number; y: number; w: number; h: number }

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value))
}

/** Reads the network output into probabilities, applying the model's output convention. */
function toProbabilities(raw: Float32Array, logits: boolean): Float32Array {
  const out = new Float32Array(raw.length)
  if (logits) for (let i = 0; i < raw.length; i++) out[i] = sigmoid(raw[i])
  else out.set(raw)
  return out
}

/** Stretches a matte to full contrast. IS-Net's saliency maps sit well below 1 on low-contrast scenes. */
function stretched(map: Float32Array): Float32Array {
  let low = Infinity
  let high = -Infinity
  for (let i = 0; i < map.length; i++) {
    if (map[i] < low) low = map[i]
    if (map[i] > high) high = map[i]
  }
  if (!(high - low > 1e-3)) return map
  const scale = 1 / (high - low)
  const out = new Float32Array(map.length)
  for (let i = 0; i < map.length; i++) out[i] = (map[i] - low) * scale
  return out
}

/** Packs an RGB square into the NCHW float tensor the networks expect. */
function toTensor(
  image: ImageData,
  scale: number,
  mean: readonly [number, number, number],
  std: readonly [number, number, number],
): Float32Array {
  const { data, width, height } = image
  const plane = width * height
  const tensor = new Float32Array(plane * 3)
  for (let i = 0; i < plane; i++) {
    tensor[i] = (data[i * 4] / scale - mean[0]) / std[0]
    tensor[plane + i] = (data[i * 4 + 1] / scale - mean[1]) / std[1]
    tensor[plane * 2 + i] = (data[i * 4 + 2] / scale - mean[2]) / std[2]
  }
  return tensor
}

/** Tight box around everything the matte considers subject, as fractions of the frame. */
function locateSubject(map: Float32Array, size: number): Box | null {
  const normalized = stretched(map)
  let minX = size
  let minY = size
  let maxX = -1
  let maxY = -1
  let count = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (normalized[y * size + x] <= 0.5) continue
      count++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  // A handful of stray pixels is noise, not a subject worth zooming into.
  if (maxX < 0 || count < size * size * 0.001) return null
  return { x: minX / size, y: minY / size, w: (maxX - minX + 1) / size, h: (maxY - minY + 1) / size }
}

/** Grows the located box by a margin and squares it up, so the zoom pass sees no extra distortion. */
function zoomBox(box: Box, imageWidth: number, imageHeight: number): Box | null {
  if (box.w * box.h >= ZOOM_CEILING) return null
  const px = { x: box.x * imageWidth, y: box.y * imageHeight, w: box.w * imageWidth, h: box.h * imageHeight }
  const margin = Math.max(px.w, px.h) * ZOOM_MARGIN
  const side = Math.max(px.w, px.h) + margin * 2
  const cx = px.x + px.w / 2
  const cy = px.y + px.h / 2
  const x = Math.max(0, Math.min(imageWidth - 1, cx - side / 2))
  const y = Math.max(0, Math.min(imageHeight - 1, cy - side / 2))
  const w = Math.min(imageWidth - x, side)
  const h = Math.min(imageHeight - y, side)
  if (w < 16 || h < 16) return null
  // No point re-running on a crop that is barely a crop.
  if ((w * h) / (imageWidth * imageHeight) >= ZOOM_CEILING) return null
  return { x, y, w, h }
}

/**
 * Soft dilation of the first pass, used to veto anything the zoomed pass finds
 * far from the subject it was pointed at — a tight crop can otherwise promote
 * background clutter to "most salient object".
 */
function subjectGate(map: Float32Array, size: number, region: Box, imageWidth: number, imageHeight: number) {
  const normalized = stretched(map)
  const x0 = Math.max(0, Math.floor((region.x / imageWidth) * size))
  const y0 = Math.max(0, Math.floor((region.y / imageHeight) * size))
  const x1 = Math.min(size, Math.ceil(((region.x + region.w) / imageWidth) * size))
  const y1 = Math.min(size, Math.ceil(((region.y + region.h) / imageHeight) * size))
  const w = Math.max(1, x1 - x0)
  const h = Math.max(1, y1 - y0)
  const crop = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) crop[y * w + x] = normalized[(y0 + y) * size + x0 + x]
  }
  const gate = resample(crop, w, h, size, size)
  // Scaled up so a partly covered neighbourhood still passes fully; this is a
  // veto on distant objects, not a second matte.
  for (let i = 0; i < gate.length; i++) gate[i] = Math.min(1, gate[i] * 4)
  return gate
}

/** Blits a resampled matte into a rectangle of the working-resolution matte. */
function blit(target: Float32Array, targetWidth: number, patch: Float32Array, region: Box) {
  const x0 = Math.round(region.x)
  const y0 = Math.round(region.y)
  const w = Math.round(region.w)
  const h = Math.round(region.h)
  for (let y = 0; y < h; y++) {
    const src = y * w
    const dst = (y0 + y) * targetWidth + x0
    for (let x = 0; x < w; x++) target[dst + x] = patch[src + x]
  }
}

export async function segment(source: ImageBitmap, runner: Runner): Promise<SegmentResult> {
  const { spec } = runner
  const size = spec.inputSize
  const bw = source.width
  const bh = source.height
  const full: Box = { x: 0, y: 0, w: bw, h: bh }

  const scale = Math.min(1, MAX_WORK_EDGE / Math.max(bw, bh))
  const width = Math.max(1, Math.round(bw * scale))
  const height = Math.max(1, Math.round(bh * scale))

  const infer = async (region: Box) => {
    const square = rasterize(source, region, size, size)
    const raw = await runner.run(toTensor(square, spec.scale, spec.mean, spec.std), size)
    return toProbabilities(raw, spec.logits)
  }

  const coarse = await infer(full)
  const alpha = resample(coarse, size, size, width, height)

  let zoomed = false
  const located = runner.refinePass ? locateSubject(coarse, size) : null
  const region = located ? zoomBox(located, bw, bh) : null
  if (region) {
    const detail = await infer(region)
    const gate = subjectGate(coarse, size, region, bw, bh)
    for (let i = 0; i < detail.length; i++) detail[i] *= gate[i]

    // Same rectangle, expressed at working resolution.
    const target: Box = {
      x: Math.round(region.x * scale),
      y: Math.round(region.y * scale),
      w: Math.min(width - Math.round(region.x * scale), Math.round(region.w * scale)),
      h: Math.min(height - Math.round(region.y * scale), Math.round(region.h * scale)),
    }
    if (target.w > 0 && target.h > 0) {
      blit(alpha, width, resample(detail, size, size, target.w, target.h), target)
      zoomed = true
    }
  }

  const work = rasterize(source, full, width, height)
  const longEdge = Math.max(width, height)
  const guideScale = Math.max(1, Math.round(longEdge / GUIDE_EDGE))
  const guide = rasterize(
    source,
    full,
    Math.max(2, Math.round(width / guideScale)),
    Math.max(2, Math.round(height / guideScale)),
  )

  const coefficients = fitCoefficients(guide, alpha, width, height, GUIDE_RADIUS, GUIDE_EPS)
  const band = bandWeight(alpha, width, height, Math.min(24, Math.max(4, Math.round(longEdge * BAND_FRACTION))))

  const out = new Uint8ClampedArray(width * height * 4)
  composeMatte(work, alpha, band, coefficients, spec.levels, out)

  return { data: out, width, height, model: spec.id, backend: runner.backend, zoomed }
}

/** Decodes any image the browser understands, honouring EXIF orientation. */
export async function decode(source: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(source, { imageOrientation: "from-image" })
  } catch {
    // Safari rejects the options bag on some builds; the plain call still applies
    // orientation for JPEG in current versions.
    return createImageBitmap(source)
  }
}
