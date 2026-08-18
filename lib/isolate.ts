import { removeBackground } from "@imgly/background-removal"

export type IsolateResult = {
  url: string
  width: number
  height: number
  bytes: number
}

export type Cutout = {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

type ProgressFn = (stage: string, ratio: number) => void

const ALPHA_THRESHOLD = 12

/** Runs the (expensive) ML background removal once per image, returns the raw cutout. */
export async function removeCutout(file: Blob, onProgress?: ProgressFn): Promise<Cutout> {
  const cutout = await removeBackground(file, {
    output: { format: "image/png", quality: 1 },
    progress: (key, current, total) => {
      const ratio = total ? current / total : 0
      onProgress?.(key.startsWith("fetch") ? "model" : "mask", ratio)
    },
  })

  const bitmap = await createImageBitmap(cutout)
  const { width, height } = bitmap

  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Canvas is not supported in this browser.")
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close?.()

  return { canvas, width, height }
}

/** Labels 4-connected blobs of visible pixels; returns a label per pixel and each blob's area + bbox. */
function labelBlobs(alpha: Uint8ClampedArray, w: number, h: number) {
  const labels = new Int32Array(w * h).fill(-1)
  const blobs: { area: number; minX: number; minY: number; maxX: number; maxY: number }[] = []
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

export type ComposeOptions = {
  /** Whitespace around the subject, proportional to its largest dimension (0-24%). */
  paddingPct: number
  /** Keep only the N largest connected regions in the mask (1-5). */
  maxSubjects: number
}

/** Cheap, pixel-only step: crop to the N largest subjects, pad, composite on white. Reusable per gesture change. */
export async function composeIsolated(cutout: Cutout, opts: ComposeOptions): Promise<IsolateResult> {
  const { canvas, width: w, height: h } = cutout
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Canvas is not supported in this browser.")
  const imageData = ctx.getImageData(0, 0, w, h)
  const { data } = imageData

  const { labels, blobs } = labelBlobs(data, w, h)

  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1

  if (blobs.length === 0) {
    minX = 0
    minY = 0
    maxX = w - 1
    maxY = h - 1
  } else {
    const keep = new Set(
      blobs
        .map((b, id) => ({ id, area: b.area }))
        .sort((a, b) => b.area - a.area)
        .slice(0, Math.max(1, Math.min(5, opts.maxSubjects)))
        .map((b) => b.id),
    )

    for (let i = 0; i < labels.length; i++) {
      if (keep.has(labels[i])) {
        const x = i % w
        const y = (i / w) | 0
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      } else {
        data[i * 4 + 3] = 0
      }
    }
  }

  const masked = document.createElement("canvas")
  masked.width = w
  masked.height = h
  const mctx = masked.getContext("2d")
  if (!mctx) throw new Error("Canvas is not supported in this browser.")
  mctx.putImageData(imageData, 0, 0)

  const cropW = maxX - minX + 1
  const cropH = maxY - minY + 1
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
  octx.drawImage(masked, minX, minY, cropW, cropH, pad, pad, cropW, cropH)

  const blob: Blob = await new Promise((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to render image."))), "image/png")
  })

  return {
    url: URL.createObjectURL(blob),
    width: outW,
    height: outH,
    bytes: blob.size,
  }
}
