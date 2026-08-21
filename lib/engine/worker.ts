/// <reference lib="webworker" />
/**
 * Hosts the whole pipeline off the main thread: decode, inference, matte
 * refinement and foreground estimation. All of it is multi-megapixel work that
 * would otherwise freeze the UI for seconds per photo.
 */
import { cutout, warm } from "./core"

type Request = { id: number; kind: "preload" } | { id: number; kind: "segment"; blob: Blob }

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  const progress = (key: string, current: number, total: number) => {
    scope.postMessage({ id: request.id, kind: "progress", key, current, total })
  }
  try {
    if (request.kind === "preload") {
      await warm(progress)
      scope.postMessage({ id: request.id, kind: "ready" })
      return
    }
    const result = await cutout(request.blob, progress)
    // The pixel buffer transfers zero-copy; the main thread puts it straight
    // onto a canvas, so the colours never make a premultiplied round trip.
    scope.postMessage({ id: request.id, kind: "matte", ...result }, [result.data.buffer])
  } catch (error) {
    scope.postMessage({
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
