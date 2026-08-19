import { removeBackground } from "@imgly/background-removal"

export type IsolateResult = {
  url: string
  width: number
  height: number
  bytes: number
}

type Blob_ = { area: number; minX: number; minY: number; maxX: number; maxY: number }
type BlobInfo = { labels: Int32Array; blobs: Blob_[] }

export type Cutout = {
  canvas: HTMLCanvasElement
  width: number
  height: number
  /** Connected-component labeling is expensive; computed once and cached lazily. */
  blobInfo?: BlobInfo
}

const ALPHA_THRESHOLD = 12

/** Runs the (expensive) ML background removal once per image, returns the raw cutout. */
export async function removeCutout(file: Blob): Promise<Cutout> {
  const cutout = await removeBackground(file, {
    output: { format: "image/png", quality: 1 },
  })

  const bitmap = await createImageBitmap(cutout)
  const { width, height } = bitmap

  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) throw new Error("Canvas is not supported in this browser.")
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close?.()

  return { canvas, width, height }
}

/** Labels 4-connected blobs of visible pixels; returns a label per pixel and each blob's area + bbox. */
function labelBlobs(alpha: Uint8ClampedArray, w: number, h: number): BlobInfo {
  const labels = new Int32Array(w * h).fill(-1)
  const blobs: Blob_[] = []
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

/** Connected components only depend on the mask itself, so this runs once per cutout and is cached on it. */
function getBlobInfo(cutout: Cutout): BlobInfo {
  if (cutout.blobInfo) return cutout.blobInfo
  const ctx = cutout.canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) throw new Error("Canvas is not supported in this browser.")
  const { data } = ctx.getImageData(0, 0, cutout.width, cutout.height)
  cutout.blobInfo = labelBlobs(data, cutout.width, cutout.height)
  return cutout.blobInfo
}

export type ComposeOptions = {
  /** Whitespace around the subject, proportional to its largest dimension (0-24%). */
  paddingPct: number
  /** Keep only the N largest connected regions in the mask (1-5). */
  maxSubjects: number
}

/**
 * Cheap, pixel-only step: crop to the N largest subjects, pad, composite on white.
 * Blob detection is cached per cutout, so this only ever touches the crop's bounding
 * box (not the full frame), making it fast enough to re-run on every gesture tick.
 */
export function composeIsolated(cutout: Cutout, opts: ComposeOptions): Promise<IsolateResult> {
  const { canvas, width: w, height: h } = cutout
  const { labels, blobs } = getBlobInfo(cutout)

  let minX = 0
  let minY = 0
  let maxX = w - 1
  let maxY = h - 1
  let keepFlags: Uint8Array | null = null

  if (blobs.length > 0) {
    const keepCount = Math.max(1, Math.min(5, opts.maxSubjects))
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

  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) throw new Error("Canvas is not supported in this browser.")
  const cropData = ctx.getImageData(minX, minY, cropW, cropH)

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
  const cctx = cropCanvas.getContext("2d")
  if (!cctx) throw new Error("Canvas is not supported in this browser.")
  cctx.putImageData(cropData, 0, 0)

  const pad = Math.round((Math.max(cropW, cropH) * opts.paddingPct) / 100)
  const outW = cropW + pad * 2
  const outH = cropH + pad * 2

  const out = document.createElement("canvas")
  out.width = outW
  out.height = outH
  const octx = out.getContext("2d")
  if (!octx) throw new Error("Canvas is not supported in this browser.")

  octx.fillStyle = "#ffffff"
  octx.fillRect(0, 0, outW, outH)
  octx.drawImage(cropCanvas, pad, pad)

  return new Promise((resolve, reject) => {
    out.toBlob((b) => {
      if (!b) return reject(new Error("Failed to render image."))
      resolve({ url: URL.createObjectURL(b), width: outW, height: outH, bytes: b.size })
    }, "image/png")
  })
}
