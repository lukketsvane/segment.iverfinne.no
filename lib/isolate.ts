/**
 * Pixel pipeline around the ML cutout: connected-component labeling, cropping
 * to the N largest subjects, padding, and compositing on white. Everything
 * here is cheap canvas work sized for phones — the expensive ML step lives in
 * lib/bg-removal.ts.
 */

export type IsolateOptions = {
  /** Whitespace around the subject, proportional to its largest dimension (0-24%). */
  paddingPct: number
  /** Keep only the N largest connected regions in the mask (1-5). */
  maxSubjects: number
}

type BlobRegion = { area: number; minX: number; minY: number; maxX: number; maxY: number }
type BlobInfo = { labels: Int32Array; blobs: BlobRegion[] }
type Crop = { canvas: HTMLCanvasElement; width: number; height: number }

export type Cutout = {
  canvas: HTMLCanvasElement
  width: number
  height: number
  /** Connected-component labeling is expensive; computed once and cached lazily. */
  blobInfo?: BlobInfo
  /** Cropped-and-masked canvases keyed by subject count, so gesture ticks never redo pixel work. */
  crops: Map<number, Crop>
}

const ALPHA_THRESHOLD = 12

/**
 * iPhone photos are 12-48MP; iOS Safari caps canvas area well below that, so
 * full-resolution pipelines silently produce blank output and huge transient
 * memory spikes. The segmentation model works at 1024px internally, so capping
 * the input's longest edge loses nothing visible and keeps every downstream
 * buffer small and safe.
 */
export const MAX_INPUT_EDGE = 2048

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error("Failed to encode image."))
    }, type)
  })
}

function get2d(canvas: HTMLCanvasElement, willReadFrequently = false) {
  const ctx = canvas.getContext("2d", willReadFrequently ? { willReadFrequently } : undefined)
  if (!ctx) throw new Error("Canvas is not supported in this browser.")
  return ctx
}

/**
 * Decodes via an <img> element (which applies EXIF orientation — portrait
 * iPhone photos are stored rotated) and downscales anything larger than
 * MAX_INPUT_EDGE before it reaches the ML pipeline. Small images in
 * browser-native formats pass through untouched.
 */
export async function normalizeImage(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = "async"
    image.src = url
    await image.decode()
    const width = image.naturalWidth
    const height = image.naturalHeight
    if (!width || !height) throw new Error("Could not read image dimensions.")

    const scale = Math.min(1, MAX_INPUT_EDGE / Math.max(width, height))
    if (scale === 1 && /^image\/(png|jpeg|webp)$/.test(file.type)) return file

    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = get2d(canvas)
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await canvasToBlob(canvas, "image/png")
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Wraps the worker's cutout bitmap in a canvas we can read pixels from. */
export function makeCutout(bitmap: ImageBitmap): Cutout {
  const width = bitmap.width
  const height = bitmap.height
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  get2d(canvas, true).drawImage(bitmap, 0, 0)
  bitmap.close?.()
  return { canvas, width, height, crops: new Map() }
}

/** Labels 4-connected blobs of visible pixels; returns a label per pixel and each blob's area + bbox. */
function labelBlobs(alpha: Uint8ClampedArray, w: number, h: number): BlobInfo {
  const labels = new Int32Array(w * h).fill(-1)
  const blobs: BlobRegion[] = []
  const stack = new Int32Array(w * h)

  for (let start = 0; start < w * h; start++) {
    if (labels[start] !== -1 || alpha[start * 4 + 3] <= ALPHA_THRESHOLD) continue

    const id = blobs.length
    let sp = 0
    stack[sp++] = start
    labels[start] = id
    let area = 0
    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1

    while (sp > 0) {
      const idx = stack[--sp]
      const x = idx % w
      const y = (idx / w) | 0
      area++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y

      if (x > 0) {
        const n = idx - 1
        if (labels[n] === -1 && alpha[n * 4 + 3] > ALPHA_THRESHOLD) {
          labels[n] = id
          stack[sp++] = n
        }
      }
      if (x < w - 1) {
        const n = idx + 1
        if (labels[n] === -1 && alpha[n * 4 + 3] > ALPHA_THRESHOLD) {
          labels[n] = id
          stack[sp++] = n
        }
      }
      if (y > 0) {
        const n = idx - w
        if (labels[n] === -1 && alpha[n * 4 + 3] > ALPHA_THRESHOLD) {
          labels[n] = id
          stack[sp++] = n
        }
      }
      if (y < h - 1) {
        const n = idx + w
        if (labels[n] === -1 && alpha[n * 4 + 3] > ALPHA_THRESHOLD) {
          labels[n] = id
          stack[sp++] = n
        }
      }
    }

    blobs.push({ area, minX, minY, maxX, maxY })
  }

  return { labels, blobs }
}

function getBlobInfo(cutout: Cutout): BlobInfo {
  if (cutout.blobInfo) return cutout.blobInfo
  const ctx = get2d(cutout.canvas, true)
  const { data } = ctx.getImageData(0, 0, cutout.width, cutout.height)
  cutout.blobInfo = labelBlobs(data, cutout.width, cutout.height)
  return cutout.blobInfo
}

/** Crop to the N largest subjects with all other blobs masked out. Cached per count. */
function getCrop(cutout: Cutout, maxSubjects: number): Crop {
  const keepCount = Math.max(1, Math.min(5, Math.round(maxSubjects)))
  const cached = cutout.crops.get(keepCount)
  if (cached) return cached

  const { canvas, width: w, height: h } = cutout
  const { labels, blobs } = getBlobInfo(cutout)

  let minX = 0
  let minY = 0
  let maxX = w - 1
  let maxY = h - 1
  let keepFlags: Uint8Array | null = null

  if (blobs.length > 0) {
    const order = blobs.map((_, id) => id).sort((a, b) => blobs[b].area - blobs[a].area)
    keepFlags = new Uint8Array(blobs.length)
    minX = w
    minY = h
    maxX = -1
    maxY = -1
    for (let i = 0; i < Math.min(keepCount, order.length); i++) {
      const id = order[i]
      keepFlags[id] = 1
      const b = blobs[id]
      if (b.minX < minX) minX = b.minX
      if (b.maxX > maxX) maxX = b.maxX
      if (b.minY < minY) minY = b.minY
      if (b.maxY > maxY) maxY = b.maxY
    }
  }

  const cropW = maxX - minX + 1
  const cropH = maxY - minY + 1
  const cropData = get2d(canvas, true).getImageData(minX, minY, cropW, cropH)

  if (keepFlags) {
    const d = cropData.data
    for (let y = 0; y < cropH; y++) {
      const rowBase = (minY + y) * w + minX
      for (let x = 0; x < cropW; x++) {
        if (!keepFlags[labels[rowBase + x]]) d[(y * cropW + x) * 4 + 3] = 0
      }
    }
  }

  const cropCanvas = document.createElement("canvas")
  cropCanvas.width = cropW
  cropCanvas.height = cropH
  get2d(cropCanvas).putImageData(cropData, 0, 0)

  const crop: Crop = { canvas: cropCanvas, width: cropW, height: cropH }
  cutout.crops.set(keepCount, crop)
  return crop
}

function paddedSize(crop: Crop, paddingPct: number) {
  const pad = Math.round((Math.max(crop.width, crop.height) * paddingPct) / 100)
  return { pad, outW: crop.width + pad * 2, outH: crop.height + pad * 2 }
}

/**
 * Draws the white-background composite letterboxed into a fixed square canvas.
 * With the crop cached, a padding tick is just a fillRect + drawImage, so this
 * is safe to run on every gesture frame — no PNG encodes, no object URLs.
 */
export function renderPreview(
  cutout: Cutout,
  opts: IsolateOptions,
  target: HTMLCanvasElement,
  sizePx: number,
): void {
  const crop = getCrop(cutout, opts.maxSubjects)
  const { pad, outW, outH } = paddedSize(crop, opts.paddingPct)
  const size = Math.max(1, Math.round(sizePx))
  if (target.width !== size || target.height !== size) {
    target.width = size
    target.height = size
  }
  const ctx = get2d(target)
  ctx.imageSmoothingQuality = "high"
  ctx.clearRect(0, 0, size, size)
  const scale = Math.min(size / outW, size / outH)
  const dw = outW * scale
  const dh = outH * scale
  const dx = (size - dw) / 2
  const dy = (size - dh) / 2
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(dx, dy, dw, dh)
  ctx.drawImage(crop.canvas, dx + pad * scale, dy + pad * scale, crop.width * scale, crop.height * scale)
}

/** Full-resolution composite as a PNG blob, for share/download. */
export function compositeBlob(cutout: Cutout, opts: IsolateOptions): Promise<Blob> {
  const crop = getCrop(cutout, opts.maxSubjects)
  const { pad, outW, outH } = paddedSize(crop, opts.paddingPct)
  const out = document.createElement("canvas")
  out.width = outW
  out.height = outH
  const ctx = get2d(out)
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, outW, outH)
  ctx.drawImage(crop.canvas, pad, pad)
  return canvasToBlob(out, "image/png")
}
