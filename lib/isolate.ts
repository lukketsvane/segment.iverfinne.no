import { removeBackground } from "@imgly/background-removal"

export type IsolateResult = {
  url: string
  width: number
  height: number
  bytes: number
}

type ProgressFn = (stage: string, ratio: number) => void

/**
 * Removes the background from an image, crops to the subject's bounding box,
 * adds proportional padding, and composites the subject onto a solid white
 * background. Everything runs client-side.
 */
export async function isolateSubject(
  file: Blob,
  paddingPct: number,
  onProgress?: ProgressFn,
): Promise<IsolateResult> {
  // 1. Remove the background -> transparent PNG blob.
  const cutout = await removeBackground(file, {
    output: { format: "image/png", quality: 1 },
    progress: (key, current, total) => {
      const ratio = total ? current / total : 0
      onProgress?.(key.startsWith("fetch") ? "Loading model" : "Removing background", ratio)
    },
  })

  onProgress?.("Cropping subject", 1)

  const bitmap = await createImageBitmap(cutout)
  const { width: w, height: h } = bitmap

  // 2. Draw the cutout to a canvas to inspect pixel alpha.
  const src = document.createElement("canvas")
  src.width = w
  src.height = h
  const sctx = src.getContext("2d")
  if (!sctx) throw new Error("Canvas is not supported in this browser.")
  sctx.drawImage(bitmap, 0, 0)
  bitmap.close?.()

  const { data } = sctx.getImageData(0, 0, w, h)

  // 3. Find the bounding box of visible (non-transparent) pixels.
  const alphaThreshold = 12
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const alpha = data[(y * w + x) * 4 + 3]
      if (alpha > alphaThreshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  // Fallback: subject fills (or nothing detected) -> keep full frame.
  if (maxX < 0) {
    minX = 0
    minY = 0
    maxX = w - 1
    maxY = h - 1
  }

  const cropW = maxX - minX + 1
  const cropH = maxY - minY + 1

  // 4. Padding is proportional to the subject's largest dimension.
  const pad = Math.round((Math.max(cropW, cropH) * paddingPct) / 100)

  const outW = cropW + pad * 2
  const outH = cropH + pad * 2

  const out = document.createElement("canvas")
  out.width = outW
  out.height = outH
  const octx = out.getContext("2d")
  if (!octx) throw new Error("Canvas is not supported in this browser.")

  // 5. Solid white background, then the cropped subject centred with padding.
  octx.fillStyle = "#ffffff"
  octx.fillRect(0, 0, outW, outH)
  octx.drawImage(src, minX, minY, cropW, cropH, pad, pad, cropW, cropH)

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
